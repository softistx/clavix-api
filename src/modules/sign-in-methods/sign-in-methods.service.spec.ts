import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { OptimisticLockError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import {
  PLATFORM_TENANT_SLUG,
  type Tenant,
  TenantSocialService,
  TenantsService,
} from "@/modules/tenants";
import { defined, instance } from "~/narrow";
import { quietTenants } from "~/ports";
import { tenantDoc } from "~/tenant-doc";
import {
  type SignInPolicy,
  signInPolicySchema,
} from "./sign-in-methods.schema";
import { createSecretBox, secretContext } from "./sign-in-methods.secrets";
import { SignInPolicyService } from "./sign-in-methods.service";

const box = createSecretBox(randomBytes(32));

/** The tenants service the policy needs, in memory: a change that answers `null` writes nothing. */
function fakeTenants(slug = "acme") {
  const state = {
    tenant: tenantDoc({ slug, signIn: signInPolicySchema.parse(undefined) }),
    writes: 0,
    lose: false,
    gone: false,
  };
  class MemoryTenants extends TenantsService {
    override async liveByIds(ids: readonly string[]) {
      return ids.includes(state.tenant._id.toHexString()) ? [state.tenant] : [];
    }

    override async anyById() {
      return state.gone ? undefined : state.tenant;
    }

    override async updateSignIn(
      _id: string,
      change: (tenant: Tenant) => SignInPolicy | null,
    ) {
      if (state.lose) throw new OptimisticLockError("lost");
      const signIn = change(state.tenant);
      if (signIn === null) return state.tenant;
      state.writes += 1;
      state.tenant = {
        ...state.tenant,
        signIn,
        version: state.tenant.version + 1,
      };
      return state.tenant;
    }
  }
  class MemorySocial extends TenantSocialService {
    override async replaceSocial(
      _tenant: Tenant,
      social: SignInPolicy["social"],
    ) {
      state.writes += 1;
      state.tenant = {
        ...state.tenant,
        signIn: { ...state.tenant.signIn, social },
      };
      return true;
    }
  }
  const social = new MemorySocial(mongo.db.tenants, {
    ...quietTenants,
    now: () => new Date(),
    log: () => {},
  });
  const service = new MemoryTenants(mongo.db.tenants, {
    ...quietTenants,
    now: () => new Date(),
    log: () => {},
  });
  const id = () => state.tenant._id.toHexString();
  return { state, id, service, social };
}

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return instance(error, GraphQLError).extensions["code"];
  }
  return undefined;
};
const setup = (slug?: string) => {
  const t = fakeTenants(slug);
  const logs: string[] = [];
  const policy = new SignInPolicyService(t.service, t.social, box, (m) =>
    logs.push(m),
  );
  return { ...t, policy, logs };
};

describe("get", () => {
  test("a tenant is read, an unknown one is NOT_FOUND", async () => {
    const { policy, id } = setup();
    expect((await policy.get(id())).slug).toBe("acme");
    expect(await codeOf(() => policy.get(new ObjectId().toHexString()))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("updateMethods", () => {
  test("it turns a method off and writes once; the same change again writes nothing", async () => {
    const { policy, state, id } = setup();
    await policy.updateMethods(id(), [{ type: "passkey", enabled: false }]);
    expect(state.writes).toBe(1);
    await policy.updateMethods(id(), [{ type: "passkey", enabled: false }]);
    expect(state.writes).toBe(1);
  });

  test("a type given twice and a method not available are refused before any read", async () => {
    const { policy } = setup();
    const unknown = new ObjectId().toHexString();
    expect(
      await codeOf(() =>
        policy.updateMethods(unknown, [
          { type: "passkey", enabled: true },
          { type: "passkey", enabled: false },
        ]),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await codeOf(() =>
        policy.updateMethods(unknown, [{ type: "password", enabled: true }]),
      ),
    ).toBe("SIGN_IN_METHOD_UNAVAILABLE");
  });

  test("the last method cannot go off; the platform tenant keeps a first-party one", async () => {
    const { policy, id } = setup();
    await policy.updateMethods(id(), [{ type: "passkey", enabled: false }]);
    expect(
      await codeOf(() =>
        policy.updateMethods(id(), [{ type: "emailCode", enabled: false }]),
      ),
    ).toBe("NO_SIGN_IN_METHOD");
    const platform = setup(PLATFORM_TENANT_SLUG);
    await platform.policy.updateMethods(platform.id(), [
      { type: "magicLink", enabled: true },
    ]);
    await platform.policy.updateMethods(platform.id(), [
      { type: "passkey", enabled: false },
    ]);
    expect(
      await codeOf(() =>
        platform.policy.updateMethods(platform.id(), [
          { type: "emailCode", enabled: false },
        ]),
      ),
    ).toBe("PLATFORM_FIRST_PARTY_METHOD");
  });

  test("a write that keeps losing the race is CONFLICT", async () => {
    const { policy, state, id } = setup();
    state.lose = true;
    expect(
      await codeOf(() =>
        policy.updateMethods(id(), [{ type: "passkey", enabled: false }]),
      ),
    ).toBe("CONFLICT");
  });
});

describe("updateMfa", () => {
  test("a field left out keeps its value and no change writes nothing", async () => {
    const { policy, state, id } = setup();
    const turned = await policy.updateMfa(id(), { totp: true });
    expect(turned.signIn.mfa).toEqual({
      mode: "passkeySufficient",
      totp: true,
    });
    await policy.updateMfa(id(), { totp: true });
    expect(state.writes).toBe(1);
  });
});

describe("setSocial", () => {
  test("a new provider needs a client id and a secret", async () => {
    const { policy, id } = setup();
    expect(
      await codeOf(() => policy.setSocial(id(), { provider: "google" })),
    ).toBe("BAD_USER_INPUT");
    expect(
      await codeOf(() =>
        policy.setSocial(id(), { provider: "google", clientId: "cid" }),
      ),
    ).toBe("SOCIAL_SECRET_REQUIRED");
  });

  test("the secret is sealed for the tenant and never stored as given", async () => {
    const { policy, id } = setup();
    const tenant = await policy.setSocial(id(), {
      provider: "google",
      clientId: " cid ",
      clientSecret: "s3cret",
    });
    const [entry] = tenant.signIn.social;
    expect(entry?.clientId).toBe("cid");
    expect(JSON.stringify(entry)).not.toContain("s3cret");
    expect(
      box.open(
        defined(entry?.secret, "the secret"),
        secretContext(id(), "google"),
      ),
    ).toBe("s3cret");
  });

  test("the same values again write nothing; a secret left out keeps the stored one", async () => {
    const { policy, state, id } = setup();
    const input = {
      provider: "github",
      clientId: "cid",
      clientSecret: "s",
    } as const;
    await policy.setSocial(id(), input);
    await policy.setSocial(id(), input);
    expect(state.writes).toBe(1);
    const before = state.tenant.signIn.social[0]?.secret;
    await policy.setSocial(id(), { provider: "github", enabled: false });
    expect(state.tenant.signIn.social[0]).toMatchObject({ enabled: false });
    expect(state.tenant.signIn.social[0]?.secret).toEqual(before);
  });

  test("the entries stay ordered by provider", async () => {
    const { policy, id } = setup();
    for (const provider of ["microsoft", "github", "google"] as const) {
      await policy.setSocial(id(), {
        provider,
        clientId: "c",
        clientSecret: "s",
      });
    }
    expect(
      (await policy.get(id())).signIn.social.map((e) => e.provider),
    ).toEqual(["github", "google", "microsoft"]);
  });
});

describe("removeSocial", () => {
  test("it drops the entry; removing it again writes nothing", async () => {
    const { policy, state, id } = setup();
    await policy.setSocial(id(), {
      provider: "google",
      clientId: "c",
      clientSecret: "s",
    });
    await policy.removeSocial(id(), "google");
    expect(state.tenant.signIn.social).toEqual([]);
    const writes = state.writes;
    await policy.removeSocial(id(), "google");
    expect(state.writes).toBe(writes);
  });
});

describe("resealSecrets", () => {
  test("a secret sealed under an older key is sealed again, and counted", async () => {
    const second = randomBytes(32);
    const older = createSecretBox(second);
    const ring = createSecretBox([randomBytes(32), second]);
    const t = fakeTenants();
    const owner = t.id();
    t.state.tenant = {
      ...t.state.tenant,
      signIn: {
        ...t.state.tenant.signIn,
        social: [
          {
            provider: "google",
            clientId: "c",
            secret: ring.seal("s", secretContext(owner, "google")),
            enabled: true,
          },
          {
            provider: "github",
            clientId: "c",
            secret: older.seal("s", secretContext(owner, "github")),
            enabled: true,
          },
        ],
      },
    };
    const policy = new SignInPolicyService(t.service, t.social, ring, () => {});
    expect(await policy.resealSecrets(owner)).toMatchObject({
      scanned: 2,
      current: 1,
      unreadable: 0,
      resealed: 1,
      skipped: 0,
      behind: 0,
    });
  });

  test("a tenant that is gone has nothing to seal", async () => {
    const t = fakeTenants();
    t.state.gone = true;
    const policy = new SignInPolicyService(t.service, t.social, box, () => {});
    expect(
      await policy.resealSecrets("65f0000000000000000000aa"),
    ).toMatchObject({
      scanned: 0,
      resealed: 0,
    });
  });
});
