import { describe, expect, test } from "bun:test";
import { OptimisticLockError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import { tenantsOver } from "~/oauth-tenants";
import { tenantDoc } from "~/tenant-doc";
import { agentsOff, type OAuthPolicy } from "./oauth-policy.schema";
import { OAuthPolicyService } from "./oauth-policy.service";

const base = (): OAuthPolicy => ({
  par: { required: false },
  dpop: { required: false },
  agents: agentsOff(),
});

// A tenants service of one tenant, holding its policy in memory.
const fake = (oauth: OAuthPolicy, live = true) => {
  const state = { tenant: tenantDoc({ oauth }), writes: 0 };
  const tenants = tenantsOver({
    liveByIds: async () => (live ? [state.tenant] : []),
    updateOAuth: async (_id, change) => {
      const next = change(state.tenant);
      if (next !== null) {
        state.writes++;
        state.tenant = { ...state.tenant, oauth: next };
      }
      return state.tenant;
    },
  });
  return { state, service: new OAuthPolicyService(tenants) };
};

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof GraphQLError ? error.extensions["code"] : undefined;
  }
  return undefined;
};

describe("OAuthPolicyService", () => {
  test("get answers NOT_FOUND for an unknown or trashed tenant", async () => {
    const { service } = fake(base(), false);
    expect(await code(() => service.get("t"))).toBe("NOT_FOUND");
    expect(await code(() => service.update("t", {}))).toBe("NOT_FOUND");
  });

  test("a flag left out keeps its value; a change writes once", async () => {
    const { service, state } = fake(base());
    const saved = await service.update("t", { par: { required: true } });
    expect(saved.oauth.par.required).toBe(true);
    expect(saved.oauth.dpop.required).toBe(false);
    expect(state.writes).toBe(1);
  });

  test("a change that changes nothing writes nothing", async () => {
    const { service, state } = fake(base());
    await service.update("t", {
      par: { required: false },
      agents: { dynamic: "off" },
    });
    expect(state.writes).toBe(0);
  });

  test("a bad agents value is BAD_USER_INPUT and stores nothing", async () => {
    const { service, state } = fake(base());
    expect(
      await code(() =>
        service.update("t", {
          par: { required: true },
          agents: { allowHosts: ["https://x.com"] },
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(state.writes).toBe(0);
  });

  test("a lost race is CONFLICT; any other failure passes through", async () => {
    const lost = new OAuthPolicyService(
      tenantsOver({
        liveByIds: async () => [tenantDoc({ oauth: base() })],
        updateOAuth: async () => {
          throw new OptimisticLockError("lost");
        },
      }),
    );
    expect(await code(() => lost.update("t", {}))).toBe("CONFLICT");
    const broken = new OAuthPolicyService(
      tenantsOver({
        liveByIds: async () => [tenantDoc({ oauth: base() })],
        updateOAuth: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(await code(() => broken.update("t", {}))).toBeUndefined();
  });
});
