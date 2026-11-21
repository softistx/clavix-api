import { beforeAll, describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { mongo } from "@/config/db";
import { dpopNonceSecretOf } from "@/config/keys";
import { noDetailTypes } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { registerClient } from "@/modules/clients";
import { createDpopKey, type DpopKey, withNonce } from "~/dpop";
import { createFlow, REDIRECT } from "~/oauth-flow";

const API = "https://api.dp-open.example/v1";
const flow = createFlow();
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

interface TokenAnswer {
  access_token?: string;
  token_type?: string;
  refresh_token?: string | null;
  error?: string;
  error_description?: string;
}

/** A public client of the tenant, DPoP-bound or not. */
async function publicClient(slug: string, dpopBound?: boolean) {
  await registerClient(
    {
      detailTypes: noDetailTypes,
      now: () => new Date(),
      db: oauthDb,
      findTenant,
    },
    {
      tenant: slug,
      name: "Pub",
      clientId: "pub",
      redirectUris: [REDIRECT],
      type: "public",
      ...(dpopBound === undefined ? {} : { dpopBound }),
    },
  );
  return { id: "pub", secret: "" };
}

/** The code exchange of a fresh authorization, with a proof from `key` (none when `key` is null). */
async function exchange(
  slug: string,
  key: DpopKey | null,
  client?: { id: string; secret: string },
  scope = "openid",
  resource?: string,
) {
  const { body, client: who } = await flow.authorizeCode(slug, scope, {
    ...(client === undefined ? {} : { client }),
    ...(resource === undefined ? {} : { resource }),
  });
  const url = flow.url(slug, "/token");
  const response = await withNonce(async (nonce) =>
    flow.post(
      slug,
      "/token",
      client === undefined ? body : { ...body, client_id: who.id },
      client === undefined ? flow.basic(who.id, who.secret) : undefined,
      key === null
        ? {}
        : {
            dpop: await key.proof("POST", url, { ...(nonce ? { nonce } : {}) }),
          },
    ),
  );
  return { response, json: (await response.clone().json()) as TokenAnswer };
}

const userinfo = (
  slug: string,
  token: string,
  scheme: "Bearer" | "DPoP",
  key: DpopKey | null,
) =>
  withNonce(async (nonce) => {
    const url = flow.url(slug, "/userinfo");
    const headers: Record<string, string> = {
      authorization: `${scheme} ${token}`,
    };
    if (key !== null) {
      headers["dpop"] = await key.proof("GET", url, {
        accessToken: token,
        ...(nonce === undefined ? {} : { nonce }),
      });
    }
    return flow.issuers.handle(new Request(url, { headers }));
  });

beforeAll(async () => {
  await flow.setUp("dp-open", [API]);
  await flow.setUp("dp-required");
  await flow.setUp("dp-client");
  const required = await findTenant("dp-required");
  if (required === undefined) throw new Error("no tenant");
  await tenantsService.updateOAuth(required._id, (tenant) => ({
    ...tenant.oauth,
    dpop: { required: true },
  }));
  // A confidential client that must bind its tokens, on a tenant that does not require it.
  const bound = await registerClient(
    {
      detailTypes: noDetailTypes,
      now: () => new Date(),
      db: oauthDb,
      findTenant,
    },
    {
      tenant: "dp-client",
      name: "Bound",
      clientId: "bound",
      redirectUris: [REDIRECT],
      type: "confidential",
      dpopBound: true,
    },
  );
  flow.clients["dp-client-bound"] = {
    id: "bound",
    secret: bound.clientSecret ?? "",
  };
});

describe("DPoP at /token", () => {
  test("a proof gives token_type DPoP and cnf.jkt in the JWT, after one use_dpop_nonce retry", async () => {
    const key = await createDpopKey();
    // First call: no nonce, the server asks for one.
    const { body, client } = await flow.authorizeCode("dp-open", "openid");
    const url = flow.url("dp-open", "/token");
    const asked = await flow.post(
      "dp-open",
      "/token",
      body,
      flow.basic(client.id, client.secret),
      { dpop: await key.proof("POST", url) },
    );
    expect(asked.status).toBe(400);
    expect(((await asked.json()) as TokenAnswer).error).toBe("use_dpop_nonce");
    const nonce = asked.headers.get("dpop-nonce") ?? "";
    expect(nonce).not.toBe("");
    // The code was not spent: the retry with the nonce succeeds.
    const retried = await flow.post(
      "dp-open",
      "/token",
      body,
      flow.basic(client.id, client.secret),
      { dpop: await key.proof("POST", url, { nonce }) },
    );
    expect(retried.status).toBe(200);
    const tokens = (await retried.json()) as TokenAnswer;
    expect(tokens.token_type).toBe("DPoP");
    expect(decodeJwt(tokens.access_token ?? "")["cnf"]).toEqual({
      jkt: key.jkt,
    });
  });

  test("EdDSA proofs are accepted, ES384 ones are not", async () => {
    const ed = await exchange("dp-open", await createDpopKey("EdDSA"));
    expect(ed.json.token_type).toBe("DPoP");
    const es384 = await exchange("dp-open", await createDpopKey("ES384"));
    expect(es384.response.status).toBe(400);
    expect(es384.json.error).toBe("invalid_dpop_proof");
  });

  test("a client that sends no proof still gets a Bearer token on a tenant that does not require DPoP", async () => {
    const { response, json } = await exchange("dp-open", null);
    expect(response.status).toBe(200);
    expect(json.token_type).toBe("Bearer");
    expect(decodeJwt(json.access_token ?? "")["cnf"]).toBeUndefined();
  });

  test("a replayed proof is refused", async () => {
    const key = await createDpopKey();
    const url = flow.url("dp-open", "/token");
    const first = await exchange("dp-open", key);
    expect(first.json.token_type).toBe("DPoP");
    // The nonce of the current window, then one proof used twice.
    const probe = await flow.authorizeCode("dp-open", "openid");
    const asked = await flow.post(
      "dp-open",
      "/token",
      probe.body,
      flow.basic(probe.client.id, probe.client.secret),
      { dpop: await key.proof("POST", url) },
    );
    const nonce = asked.headers.get("dpop-nonce") ?? "";
    const proof = await key.proof("POST", url, { nonce });
    const used = await flow.post(
      "dp-open",
      "/token",
      probe.body,
      flow.basic(probe.client.id, probe.client.secret),
      { dpop: proof },
    );
    expect(used.status).toBe(200);
    const again = await flow.authorizeCode("dp-open", "openid");
    const replay = await flow.post(
      "dp-open",
      "/token",
      again.body,
      flow.basic(again.client.id, again.client.secret),
      { dpop: proof },
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as TokenAnswer).error_description).toContain(
      "already used",
    );
  });

  test("the proof's htu is the public issuer URL, not another", async () => {
    const key = await createDpopKey();
    const { body, client } = await flow.authorizeCode("dp-open", "openid");
    const wrong = await flow.post(
      "dp-open",
      "/token",
      body,
      flow.basic(client.id, client.secret),
      { dpop: await key.proof("POST", "http://localhost:3000/token") },
    );
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as TokenAnswer).error).toBe(
      "invalid_dpop_proof",
    );
  });
});

describe("a public client's refresh token", () => {
  test("is bound to the key of the code exchange, and refreshing needs the same key", async () => {
    const client = await publicClient("dp-open");
    const key = await createDpopKey();
    const { json } = await exchange("dp-open", key, client, "openid");
    expect(json.token_type).toBe("DPoP");
    const refresh = json.refresh_token ?? "";
    expect(refresh).not.toBe("");
    const url = flow.url("dp-open", "/token");
    const body = {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: "pub",
    };
    const send = (signer: DpopKey | null) =>
      withNonce(async (nonce) =>
        flow.post(
          "dp-open",
          "/token",
          body,
          undefined,
          signer === null
            ? {}
            : {
                dpop: await signer.proof("POST", url, {
                  ...(nonce === undefined ? {} : { nonce }),
                }),
              },
        ),
      );
    // No proof, then another key: nothing rotates.
    expect((await send(null)).status).toBe(400);
    const other = await send(await createDpopKey());
    expect(other.status).toBe(400);
    expect(((await other.json()) as TokenAnswer).error).toBe(
      "invalid_dpop_proof",
    );
    // The same key works, and the new access token is bound to it.
    const ok = await send(key);
    expect(ok.status).toBe(200);
    const refreshed = (await ok.json()) as TokenAnswer;
    expect(refreshed.token_type).toBe("DPoP");
    expect(decodeJwt(refreshed.access_token ?? "")["cnf"]).toEqual({
      jkt: key.jkt,
    });
  });
});

describe("DPoP required", () => {
  test("per tenant: a request with no proof is refused", async () => {
    const refused = await exchange("dp-required", null);
    expect(refused.response.status).toBe(400);
    expect(refused.json.error).toBe("invalid_dpop_proof");
    const accepted = await exchange("dp-required", await createDpopKey());
    expect(accepted.json.token_type).toBe("DPoP");
  });

  test("per client: the bound client needs a proof, another client of the tenant does not", async () => {
    const bound = flow.clients["dp-client-bound"];
    if (bound === undefined) throw new Error("no bound client");
    const refused = await exchange("dp-client", null, undefined, "openid");
    // `backend` is not bound: it works without a proof.
    expect(refused.json.token_type).toBe("Bearer");
    const { body } = await flow.authorizeCode("dp-client", "openid", {
      client: bound,
    });
    const without = await flow.post(
      "dp-client",
      "/token",
      body,
      flow.basic(bound.id, bound.secret),
    );
    expect(without.status).toBe(400);
    expect(((await without.json()) as TokenAnswer).error).toBe(
      "invalid_dpop_proof",
    );
  });

  test("the policy is stored as written and a new tenant is off", async () => {
    const created = await tenantsService.create({ slug: "dp-new", name: "N" });
    expect(created.oauth.dpop.required).toBe(false);
    expect((await findTenant("dp-required"))?.oauth.dpop.required).toBe(true);
  });
});

describe("a DPoP token at the resources", () => {
  test("userinfo accepts it as DPoP with a proof, and refuses it as Bearer", async () => {
    const key = await createDpopKey();
    const { json } = await exchange("dp-open", key);
    const token = json.access_token ?? "";
    const ok = await userinfo("dp-open", token, "DPoP", key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sub: "user-dp-open" });
    const bearer = await userinfo("dp-open", token, "Bearer", null);
    expect(bearer.status).toBe(401);
    const stolen = await userinfo(
      "dp-open",
      token,
      "DPoP",
      await createDpopKey(),
    );
    expect(stolen.status).toBe(401);
  });

  test("introspection reports token_type DPoP and the key", async () => {
    const key = await createDpopKey();
    const { json } = await exchange("dp-open", key, undefined, "read", API);
    const client = flow.clients["dp-open"] ?? { id: "", secret: "" };
    const answer = await flow.post(
      "dp-open",
      "/introspect",
      { token: json.access_token ?? "" },
      flow.basic(client.id, client.secret),
    );
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      active: true,
      token_type: "DPoP",
      cnf: { jkt: key.jkt },
    });
  });
});

describe("the nonce secret", () => {
  test("is derived from the first master key: stable, distinct per key, not the key itself", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(dpopNonceSecretOf([a])).toBe(dpopNonceSecretOf([a, b]));
    expect(dpopNonceSecretOf([a])).not.toBe(dpopNonceSecretOf([b]));
    expect(dpopNonceSecretOf([a])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(dpopNonceSecretOf([a])).not.toBe(
      Buffer.from(a).toString("base64url"),
    );
  });
});
