import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { createApp } from "@/app";
import { connectionsService } from "@/config/connections";
import { consentService } from "@/config/consent";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { createGrantsRevoke, grantsRevokeQueue } from "@/config/grants-revoke";
import { secretBox } from "@/config/keys";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { RevokeJob } from "@/modules/consent/consent.types";
import {
  issuerOf,
  PLATFORM_TENANT_SLUG,
  TenantsService,
} from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users/tenant-janus";
import { createFlow } from "../../../test/oauth-flow";
import { createTenantParOff } from "../../../test/tenant-par-off";
import { SignInPolicyService } from "./sign-in-methods.service";

// The OAuth issuers are mounted: the replacement revokes the former holder's grants through them.
const flow = createFlow();
// `revokeAll` can be made to reject, to see the failure path of the replacement (#353).
const revokeDown = { on: false, calls: 0 };
const issuers = {
  ...flow.issuers,
  serverFor: async (request: Request) => {
    const server = await flow.issuers.serverFor(request);
    if (server === null || !revokeDown.on) return server;
    return {
      ...server,
      grants: {
        ...server.grants,
        revokeAll: async () => {
          revokeDown.calls += 1;
          throw new Error("store down");
        },
      },
    };
  },
};
const app = createApp({ oauth: issuers });
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const tenants = new TenantsService(mongo.db.tenants, {
  onHostsChanged: (hosts) => tenantResolver.invalidate(hosts),
});
const policy = new SignInPolicyService(tenants, secretBox);
const SECRET = "gh-spec-secret-do-not-leak";

interface Answer {
  status: number;
  data: Record<string, unknown> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
  cookies: string[];
  text: string;
}

async function gql(
  slug: string,
  query: string,
  variables: Record<string, unknown> = {},
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await app.request(`${issuerOf(slug, origin)}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.23",
      ...headers,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  const body = JSON.parse(text) as Pick<Answer, "data" | "errors">;
  return {
    status: response.status,
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
    cookies: response.headers.getSetCookie(),
    text,
  };
}
const codeOf = (answer: Answer) => answer.errors?.[0]?.extensions?.["code"];

const HOSTED = "{ hostedSignInMethods { methods social { id label } } }";
const START = `mutation ($p: String!, $r: String) {
  socialSignInStart(provider: $p, returnTo: $r) { url flow expiresAt }
}`;
const COMPLETE = `mutation ($u: String!, $f: String!) {
  socialSignInComplete(callbackUrl: $u, flow: $f) {
    ... on SocialSignedIn { created replaced returnTo expiresAt user { id email name emailVerified } }
  }
}`;
const REQUEST_CODE = `mutation { requestSignInCode(email: "ada@example.com") { expiresAt } }`;
const PASSKEY_OPTIONS = "mutation { passkeySignInOptions { challenge } }";

let social = "";
let other = "";
let grants = "";

beforeAll(async () => {
  await createTenantParOff(tenants, { slug: "sih-open", name: "Open" });
  // "social" lets strangers sign up; "other" does not.
  social = (
    await createTenantParOff(tenants, {
      slug: "sih-social",
      name: "Social",
      signUp: true,
    })
  ).id;
  other = (
    await createTenantParOff(tenants, { slug: "sih-other", name: "Other" })
  ).id;
  await policy.setSocial(social, {
    provider: "github",
    clientId: "gh-client-social",
    clientSecret: SECRET,
  });
  await policy.setSocial(other, {
    provider: "github",
    clientId: "gh-client-other",
    clientSecret: `${SECRET}-other`,
  });
  // A tenant with a signing key and a client, for the grants of a replaced holder.
  grants = (await flow.setUp("sih-grants")).tenantId;
  await policy.setSocial(grants, {
    provider: "github",
    clientId: "gh-client-grants",
    clientSecret: `${SECRET}-grants`,
  });
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $nin: [PLATFORM_TENANT_SLUG] },
  });
  await oauthDb.collection("users").deleteMany({});
});

describe("hostedSignInMethods", () => {
  test("a new tenant offers passkey and e-mail code, no social provider", async () => {
    const answer = await gql("sih-open", HOSTED);
    expect(answer.data).toEqual({
      hostedSignInMethods: { methods: ["PASSKEY", "EMAIL_CODE"], social: [] },
    });
  });

  test("it is the tenant of the host: its methods and providers, never a client id or a secret", async () => {
    await policy.updateMethods(social, [
      { type: "magicLink", enabled: true },
      { type: "passkey", enabled: false },
    ]);
    const answer = await gql("sih-social", HOSTED);
    expect(answer.data).toEqual({
      hostedSignInMethods: {
        methods: ["EMAIL_CODE", "MAGIC_LINK"],
        social: [{ id: "github", label: "GitHub" }],
      },
    });
    expect(answer.text).not.toContain("gh-client-social");
    // The other tenants are unchanged.
    expect(
      (await gql("sih-open", HOSTED)).data?.["hostedSignInMethods"],
    ).toEqual({ methods: ["PASSKEY", "EMAIL_CODE"], social: [] });
  });

  test("a disabled provider is not offered", async () => {
    await policy.setSocial(other, { provider: "github", enabled: false });
    expect(
      (await gql("sih-other", HOSTED)).data?.["hostedSignInMethods"],
    ).toEqual({ methods: ["PASSKEY", "EMAIL_CODE"], social: [] });
    await policy.setSocial(other, { provider: "github", enabled: true });
  });

  describe("enterprise connections", () => {
    // A connection is offered only when it can be opened: a verified domain
    // and a secret the box opens (what `ConnectionsService.build` checks).
    const connect = async (
      id: string,
      name: string,
      extra: {
        showButton?: boolean;
        enabled?: boolean;
        verified?: boolean;
      } = {},
    ) => {
      const { verified = true, ...rest } = extra;
      const created = await connectionsService.create(
        social,
        {
          id,
          name,
          issuer: "https://idp.sih-social.test",
          clientId: "sih-client",
          clientSecret: "sih-conn-secret",
          ...rest,
        },
        null,
      );
      if (verified) {
        const now = new Date();
        await mongo.db.connections.raw.updateOne(
          { connectionId: id },
          {
            $set: {
              domains: [
                {
                  domain: `${id}.sih.test`,
                  txtToken: "t",
                  verifiedAt: now,
                  checkedAt: now,
                },
              ],
            },
          },
        );
      }
      return created;
    };
    const offered = async () => {
      const answer = await gql("sih-social", HOSTED);
      const hosted = answer.data?.["hostedSignInMethods"] as
        | { social: { id: string; label: string }[] }
        | undefined;
      return hosted?.social ?? [];
    };

    afterEach(async () => {
      for (const doc of await connectionsService.list(social)) {
        await connectionsService.delete(social, doc.connectionId);
      }
    });

    test("an enabled connection with showButton follows the static providers", async () => {
      await connect("acme", "Acme SSO", { showButton: true });
      const answer = await gql("sih-social", HOSTED);
      expect(await offered()).toEqual([
        { id: "github", label: "GitHub" },
        { id: "acme", label: "Acme SSO" },
      ]);
      expect(answer.text).not.toContain("sih-conn-secret");
    });

    test("a connection without a verified domain is not offered, and cannot start", async () => {
      await connect("unverified", "Unverified SSO", {
        showButton: true,
        verified: false,
      });
      expect(await offered()).toEqual([{ id: "github", label: "GitHub" }]);
      const answer = await gql("sih-social", START, {
        p: "unverified",
        r: null,
      });
      expect(codeOf(answer)).toBe("SIGN_IN_METHOD_DISABLED");
    });

    test("a connection whose secret cannot be opened is not offered", async () => {
      await connect("sealed", "Sealed SSO", { showButton: true });
      await mongo.db.connections.raw.updateOne(
        { connectionId: "sealed" },
        { $set: { secret: { v: 1, kid: "dropped-key", iv: "x", ct: "x" } } },
      );
      expect(await offered()).toEqual([{ id: "github", label: "GitHub" }]);
    });

    test("a connection without showButton stays out", async () => {
      await connect("quiet", "Quiet SSO");
      expect(await offered()).toEqual([{ id: "github", label: "GitHub" }]);
    });

    test("a disabled connection with showButton stays out", async () => {
      await connect("off", "Off SSO", { showButton: true, enabled: false });
      expect(await offered()).toEqual([{ id: "github", label: "GitHub" }]);
    });

    test("another tenant's connection is never offered", async () => {
      await connect("acme", "Acme SSO", { showButton: true });
      expect(
        (await gql("sih-other", HOSTED)).data?.["hostedSignInMethods"],
      ).toEqual({
        methods: ["PASSKEY", "EMAIL_CODE"],
        social: [{ id: "github", label: "GitHub" }],
      });
    });

    test("a tenant with only a shown connection offers it alone", async () => {
      await connect("solo", "Solo SSO", { showButton: true });
      await policy.setSocial(social, { provider: "github", enabled: false });
      expect(await offered()).toEqual([{ id: "solo", label: "Solo SSO" }]);
      await policy.setSocial(social, { provider: "github", enabled: true });
    });
  });

  test("an unknown host is NOT_FOUND", async () => {
    const answer = await gql("sih-nobody", HOSTED);
    expect(codeOf(answer)).toBe("NOT_FOUND");
  });
});

describe("a method the tenant turned off", () => {
  test("the passkey sign-in answers SIGN_IN_METHOD_DISABLED (404); the e-mail code still works", async () => {
    const answer = await gql("sih-social", PASSKEY_OPTIONS);
    expect(codeOf(answer)).toBe("SIGN_IN_METHOD_DISABLED");
    expect(answer.status).toBe(404);
    expect((await gql("sih-social", REQUEST_CODE)).errors).toBeUndefined();
    // Another tenant keeps its passkeys.
    expect((await gql("sih-open", PASSKEY_OPTIONS)).errors).toBeUndefined();
  });

  test("the second step of each method is closed too", async () => {
    const passkey = await gql(
      "sih-social",
      `mutation { signInWithPasskey(challenge: "c", response: "{}") { expiresAt } }`,
    );
    expect(codeOf(passkey)).toBe("SIGN_IN_METHOD_DISABLED");
    await policy.updateMethods(social, [{ type: "emailCode", enabled: false }]);
    const code = await gql(
      "sih-social",
      `mutation { verifySignInCode(challenge: "c", code: "000000") { __typename } }`,
    );
    expect(codeOf(code)).toBe("SIGN_IN_METHOD_DISABLED");
    await policy.updateMethods(social, [{ type: "emailCode", enabled: true }]);
  });

  test("the e-mail code answers SIGN_IN_METHOD_DISABLED once it is off", async () => {
    await policy.updateMethods(social, [{ type: "emailCode", enabled: false }]);
    const answer = await gql("sih-social", REQUEST_CODE);
    expect(codeOf(answer)).toBe("SIGN_IN_METHOD_DISABLED");
    expect(answer.status).toBe(404);
    await policy.updateMethods(social, [{ type: "emailCode", enabled: true }]);
    expect((await gql("sih-social", REQUEST_CODE)).errors).toBeUndefined();
  });
});

describe("social sign-in", () => {
  test("a tenant with no provider, or a provider it does not offer: SIGN_IN_METHOD_DISABLED", async () => {
    for (const [slug, provider] of [
      ["sih-open", "github"],
      ["sih-social", "google"],
      ["sih-social", "nope"],
    ] as const) {
      const answer = await gql(slug, START, { p: provider });
      expect(codeOf(answer)).toBe("SIGN_IN_METHOD_DISABLED");
      expect(answer.status).toBe(404);
    }
    expect(
      codeOf(await gql("sih-open", COMPLETE, { u: "https://x/cb", f: "f" })),
    ).toBe("SIGN_IN_METHOD_DISABLED");
  });

  test("start sends the visitor to the provider with the tenant's own client id and callback", async () => {
    const answer = await gql("sih-social", START, {
      p: "github",
      r: "/account",
    });
    expect(answer.errors).toBeUndefined();
    const start = answer.data?.["socialSignInStart"] as {
      url: string;
      flow: string;
    };
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("gh-client-social");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${issuerOf("sih-social", origin)}/sign-in/social/github/callback`,
    );
    expect(answer.text).not.toContain(SECRET);
    expect(start.flow.length).toBeGreaterThan(10);

    const theirs = await startOn("sih-other");
    expect(new URL(theirs.url).searchParams.get("client_id")).toBe(
      "gh-client-other",
    );
  });

  test("two tenants interleaved each resolve their own provider on every call", async () => {
    for (const [slug, clientId] of [
      ["sih-other", "gh-client-other"],
      ["sih-social", "gh-client-social"],
      ["sih-other", "gh-client-other"],
    ] as const) {
      const start = await startOn(slug);
      expect(new URL(start.url).searchParams.get("client_id")).toBe(clientId);
    }
  });

  test("one request resolves the tenant's instance once", async () => {
    const spy = spyOn(janusIssuers, "forRequest");
    try {
      await startOn("sih-social");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a provider changed while the app runs is read afresh on the next call", async () => {
    const mid = (
      await createTenantParOff(tenants, { slug: "sih-mid", name: "Mid" })
    ).id;
    for (const clientId of ["gh-mid-1", "gh-mid-2", "gh-mid-1"]) {
      await policy.setSocial(mid, {
        provider: "github",
        clientId,
        clientSecret: `${SECRET}-mid`,
      });
      const start = await startOn("sih-mid");
      expect(new URL(start.url).searchParams.get("client_id")).toBe(clientId);
    }
    await policy.removeSocial(mid, "github");
    const gone = await gql("sih-mid", START, { p: "github", r: null });
    expect(codeOf(gone)).toBeDefined();
  });

  test("complete exchanges the code with the tenant's secret, creates the user and opens the session", async () => {
    const start = await startOn("sih-social");
    const { calls, run } = github("ada@social.example");
    // The flow of tenant "social" means nothing to tenant "other".
    const wrongTenant = await run(() =>
      gql("sih-other", COMPLETE, {
        u: callbackOf("sih-other", start.state),
        f: start.flow,
      }),
    );
    expect(wrongTenant.errors).toBeDefined();
    expect(wrongTenant.cookies).toEqual([]);

    const active = spyOn(usageService, "recordActive");
    const answer = await run(() =>
      gql("sih-social", COMPLETE, {
        u: callbackOf("sih-social", start.state),
        f: start.flow,
      }),
    );
    expect(answer.errors).toBeUndefined();
    const done = answer.data?.["socialSignInComplete"] as {
      created: boolean;
      user: { id: string; email: string; name: string; emailVerified: boolean };
    };
    expect(done.created).toBe(true);
    expect(active).toHaveBeenCalledTimes(1);
    expect(active.mock.calls[0]?.[1]).toBe(done.user.id);
    expect(done.user).toMatchObject({
      email: "ada@social.example",
      name: "Ada Lovelace",
      emailVerified: true,
    });
    const cookie = answer.cookies.find((c) => c.startsWith(SESSION_COOKIE));
    expect(cookie).toBeDefined();
    expect(answer.text).not.toContain(SECRET);

    // The tenant's own secret went to the provider, and nowhere else.
    const token = calls.find((c) => c.url.endsWith("/access_token"));
    const sent = `${token?.body} ${decodeURIComponent(
      atob(token?.authorization.replace(/^Basic /, "") ?? ""),
    )}`;
    expect(sent).toContain(SECRET);
    expect(sent).not.toContain(`${SECRET}-other`);
    expect(
      calls.every((c) => /^https:\/\/(api\.)?github\.com\//.test(c.url)),
    ).toBe(true);

    // The session is the tenant's: it reads the user back there, not elsewhere.
    const session = (cookie ?? "").split(";")[0] ?? "";
    const me = "{ currentUser { email } }";
    expect((await gql("sih-social", me, {}, session)).data).toEqual({
      currentUser: { email: "ada@social.example" },
    });
    expect((await gql("sih-other", me, {}, session)).data).toEqual({
      currentUser: null,
    });
  });

  test("a built-in app's proof replaces an unverified holder of the address: replaced, and recorded in the sign-in log (nxgt-janus #978)", async () => {
    const auth = await janusIssuers.forRequest(
      new Request(`${issuerOf("sih-social", origin)}/`),
    );
    if (auth === null) throw new Error("no janus for sih-social");
    const holder = await auth.create({ email: "squat@social.example" });
    const start = await startOn("sih-social");
    const { run } = github("squat@social.example");
    const answer = await run(() =>
      gql("sih-social", COMPLETE, {
        u: callbackOf("sih-social", start.state),
        f: start.flow,
      }),
    );
    expect(answer.errors).toBeUndefined();
    const done = answer.data?.["socialSignInComplete"] as {
      created: boolean;
      replaced: boolean;
      user: { id: string; emailVerified: boolean };
    };
    expect(done).toMatchObject({ created: false, replaced: true });
    expect(done.user).toMatchObject({ id: holder.id, emailVerified: true });
    const events = await mongo.db.authEvents.raw
      .find({ userId: holder.id, type: "session.signIn" })
      .toArray();
    expect(events.map((event) => event["reason"])).toEqual(["replaced"]);
  });

  test("replacing an unverified holder revokes their OAuth grants and refresh token; a verified user's stand (clavix-api #346)", async () => {
    const auth = await janusIssuers.forRequest(
      new Request(`${issuerOf("sih-grants", origin)}/`),
    );
    if (auth === null) throw new Error("no janus for sih-grants");
    const holder = await auth.create({ email: "grants@social.example" });
    const held = await flow.tokensOf("sih-grants", "openid", {
      userId: holder.id,
    });
    expect(held.refresh_token ?? "").not.toBe("");
    const client = flow.clients["sih-grants"] ?? { id: "", secret: "" };
    const refresh = (token: string) =>
      flow.post(
        "sih-grants",
        "/token",
        { grant_type: "refresh_token", refresh_token: token },
        flow.basic(client.id, client.secret),
      );
    const signIn = async () => {
      const start = await startOn("sih-grants");
      const { run } = github("grants@social.example");
      const answer = await run(() =>
        gql("sih-grants", COMPLETE, {
          u: callbackOf("sih-grants", start.state),
          f: start.flow,
        }),
      );
      expect(answer.errors).toBeUndefined();
      return answer.data?.["socialSignInComplete"] as {
        replaced: boolean;
        user: { id: string };
      };
    };
    const replaced = await signIn();
    expect(replaced).toMatchObject({ replaced: true, user: { id: holder.id } });
    const refused = await refresh(held.refresh_token ?? "");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );

    // A grant the (now verified) user makes afterwards survives a plain sign-in.
    const kept = await flow.tokensOf("sih-grants", "openid", {
      userId: holder.id,
    });
    expect((await signIn()).replaced).toBe(false);
    expect((await refresh(kept.refresh_token ?? "")).status).toBe(200);
  });

  test("a revocation that fails at a replace is queued and retried until the refresh token is refused (clavix-api #353)", async () => {
    const auth = await janusIssuers.forRequest(
      new Request(`${issuerOf("sih-grants", origin)}/`),
    );
    if (auth === null) throw new Error("no janus for sih-grants");
    const holder = await auth.create({ email: "retry@social.example" });
    const held = await flow.tokensOf("sih-grants", "openid", {
      userId: holder.id,
    });
    const client = flow.clients["sih-grants"] ?? { id: "", secret: "" };
    const refresh = () =>
      flow.post(
        "sih-grants",
        "/token",
        {
          grant_type: "refresh_token",
          refresh_token: held.refresh_token ?? "",
        },
        flow.basic(client.id, client.secret),
      );
    const signIn = async () => {
      const start = await startOn("sih-grants");
      const { run } = github("retry@social.example");
      return run(() =>
        gql("sih-grants", COMPLETE, {
          u: callbackOf("sih-grants", start.state),
          f: start.flow,
        }),
      );
    };
    const jobs: RevokeJob[] = [];
    let handler: ((job: { data: RevokeJob }) => Promise<unknown>) | undefined;
    const previous = grantsRevokeQueue.current;
    grantsRevokeQueue.current = {
      add: async (data) => {
        jobs.push(data);
      },
    };
    consentService.startRevokeWorker(
      createGrantsRevoke(flow.issuers.serverFor),
      {
        work: (fn) => {
          handler = fn;
          return { on: () => {} };
        },
      },
    );
    revokeDown.on = true;
    revokeDown.calls = 0;
    try {
      const answer = await signIn();
      // The sign-in succeeded: the job is stored, the grants still stand.
      expect(answer.errors).toBeUndefined();
      expect(answer.data?.["socialSignInComplete"]).toMatchObject({
        replaced: true,
      });
      expect(revokeDown.calls).toBe(1);
      expect(jobs).toEqual([{ tenantId: grants, userId: holder.id }]);
      expect((await refresh()).status).toBe(200);
    } finally {
      revokeDown.on = false;
    }
    // The first run of the job fails (the store is still down for it), the retry succeeds.
    revokeDown.on = true;
    const down = createGrantsRevoke(issuers.serverFor);
    await expect(down(jobs[0] as RevokeJob)).rejects.toThrow("store down");
    revokeDown.on = false;
    await handler?.({ data: jobs[0] as RevokeJob });
    const refused = await refresh();
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    grantsRevokeQueue.current = previous;
  });

  test("a revocation that cannot be queued fails the sign-in, as before", async () => {
    const auth = await janusIssuers.forRequest(
      new Request(`${issuerOf("sih-grants", origin)}/`),
    );
    if (auth === null) throw new Error("no janus for sih-grants");
    await auth.create({ email: "noqueue@social.example" });
    const previous = grantsRevokeQueue.current;
    grantsRevokeQueue.current = {
      add: async () => {
        throw new Error("redis down");
      },
    };
    revokeDown.on = true;
    try {
      const start = await startOn("sih-grants");
      const { run } = github("noqueue@social.example");
      const answer = await run(() =>
        gql("sih-grants", COMPLETE, {
          u: callbackOf("sih-grants", start.state),
          f: start.flow,
        }),
      );
      expect(answer.errors?.length).toBe(1);
      expect(answer.data?.["socialSignInComplete"] ?? null).toBeNull();
    } finally {
      revokeDown.on = false;
      grantsRevokeQueue.current = previous;
    }
  });

  test("a verified user is linked, never replaced: replaced is false and no reason is recorded", async () => {
    const first = await startOn("sih-social");
    const { run } = github("kept@social.example");
    const created = await run(() =>
      gql("sih-social", COMPLETE, {
        u: callbackOf("sih-social", first.state),
        f: first.flow,
      }),
    );
    expect(created.errors).toBeUndefined();
    const again = await startOn("sih-social");
    const answer = await run(() =>
      gql("sih-social", COMPLETE, {
        u: callbackOf("sih-social", again.state),
        f: again.flow,
      }),
    );
    const done = answer.data?.["socialSignInComplete"] as {
      created: boolean;
      replaced: boolean;
      user: { id: string };
    };
    expect(done).toMatchObject({ created: false, replaced: false });
    const events = await mongo.db.authEvents.raw
      .find({ userId: done.user.id, type: "session.signIn" })
      .toArray();
    expect(events.map((event) => event["reason"])).toEqual([null, null]);
  });

  test("returnTo must be a path of the site: no open redirect", async () => {
    for (const r of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      const answer = await gql("sih-social", START, { p: "github", r });
      expect(answer.errors).toBeDefined();
      expect(answer.data?.["socialSignInStart"] ?? null).toBeNull();
    }
  });

  test("a flow is single-use: completing it twice fails the second time", async () => {
    const start = await startOn("sih-social");
    const { run } = github("grace@social.example");
    const vars = {
      u: callbackOf("sih-social", start.state),
      f: start.flow,
    };
    const first = await run(() => gql("sih-social", COMPLETE, vars));
    expect(first.errors).toBeUndefined();
    const replay = await run(() => gql("sih-social", COMPLETE, vars));
    expect(replay.errors).toBeDefined();
    expect(replay.cookies).toEqual([]);
  });

  test("a replayed or garbage flow costs no provider call (why socialSignInComplete needs no throttle of its own)", async () => {
    const start = await startOn("sih-social");
    const { calls, run } = github("hopper@social.example");
    const vars = {
      u: callbackOf("sih-social", start.state),
      f: start.flow,
    };
    expect(
      (await run(() => gql("sih-social", COMPLETE, vars))).errors,
    ).toBeUndefined();
    const spent = calls.length;
    expect(spent).toBeGreaterThan(0);
    const attempts = [
      vars,
      { ...vars, f: "not-a-flow" },
      { u: "not a url", f: start.flow },
      { u: callbackOf("sih-social", "forged-state"), f: "x".repeat(200) },
    ];
    for (const attempt of attempts) {
      const answer = await run(() => gql("sih-social", COMPLETE, attempt));
      expect(answer.errors).toBeDefined();
      expect(answer.cookies).toEqual([]);
    }
    expect(calls.length).toBe(spent);
  });

  test("a tenant with sign-up closed does not make a user from a stranger's account", async () => {
    const start = await startOn("sih-other");
    const { run } = github("stranger@social.example");
    const answer = await run(() =>
      gql("sih-other", COMPLETE, {
        u: callbackOf("sih-other", start.state),
        f: start.flow,
      }),
    );
    expect(codeOf(answer)).toBe("SIGN_UP_DISABLED");
    expect(answer.cookies).toEqual([]);
    expect(answer.text).not.toContain(SECRET);
  });

  test("a flow begun before the provider was removed cannot be completed", async () => {
    const start = await startOn("sih-other");
    await policy.removeSocial(other, "github");
    const { calls, run } = github("late@social.example");
    const answer = await run(() =>
      gql("sih-other", COMPLETE, {
        u: callbackOf("sih-other", start.state),
        f: start.flow,
      }),
    );
    expect(codeOf(answer)).toBe("SIGN_IN_METHOD_DISABLED");
    expect(answer.cookies).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a provider whose secret was sealed under another master key is not offered", async () => {
    await mongo.db.tenants.raw.updateOne(
      { slug: "sih-social" },
      {
        $set: { "signIn.social.0.secret.kid": "another-key" },
        $inc: { version: 1 },
      },
    );
    await tenantResolver.invalidate([
      new URL(issuerOf("sih-social", origin)).host,
    ]);
    const hosted = await gql("sih-social", HOSTED);
    expect(hosted.data?.["hostedSignInMethods"]).toMatchObject({ social: [] });
    const answer = await gql("sih-social", START, { p: "github" });
    expect(codeOf(answer)).toBe("SIGN_IN_METHOD_DISABLED");
    expect(answer.text).not.toContain("github");
  });

  test("a built-in app completes through the bound callback path: the BFF's x-sso-connection names it, nothing refuses it (nxgt-janus#987)", async () => {
    const tenant = await createTenantParOff(tenants, {
      slug: "sih-bound",
      name: "Bound",
      signUp: true,
    });
    await policy.setSocial(tenant.id, {
      provider: "github",
      clientId: "gh-client-bound",
      clientSecret: SECRET,
    });
    const start = await startOn("sih-bound");
    const { run } = github("bound@social.example");
    const answer = await run(() =>
      gql(
        "sih-bound",
        COMPLETE,
        { u: callbackOf("sih-bound", start.state), f: start.flow },
        undefined,
        { "x-sso-connection": "github" },
      ),
    );
    expect(answer.errors).toBeUndefined();
    expect(
      (
        answer.data?.["socialSignInComplete"] as
          | { created: boolean }
          | undefined
      )?.created,
    ).toBe(true);
  });
});

const callbackOf = (slug: string, state: string) =>
  `${issuerOf(slug, origin)}/sign-in/social/github/callback?code=gh-code&state=${encodeURIComponent(state)}`;

async function startOn(slug: string) {
  const started = await gql(slug, START, { p: "github" });
  const start = started.data?.["socialSignInStart"] as {
    url: string;
    flow: string;
  };
  return {
    url: start.url,
    flow: start.flow,
    state: new URL(start.url).searchParams.get("state") ?? "",
  };
}

/** GitHub's three endpoints, answered in place of the network while `run` runs. */
function github(email: string) {
  const calls: { url: string; body: string; authorization: string }[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  const fake = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as string, init);
    const url = request.url;
    calls.push({
      url,
      body: await request.clone().text(),
      authorization: request.headers.get("authorization") ?? "",
    });
    if (url === "https://github.com/login/oauth/access_token") {
      return json({ access_token: "gh-access", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return json({ id: email.length * 1000 + 42, name: "Ada Lovelace" });
    }
    if (url === "https://api.github.com/user/emails") {
      return json([{ email, primary: true, verified: true }]);
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      return await work();
    } finally {
      globalThis.fetch = real;
    }
  };
  return { calls, run };
}
