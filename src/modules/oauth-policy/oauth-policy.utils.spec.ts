import { describe, expect, it } from "bun:test";
import { ObjectId } from "mongodb";
import type { Tenant } from "@/modules/tenants";
import { MODE, MODE_NAME, policyOf } from "./oauth-policy.utils";

describe("oauth policy utils", () => {
  it("maps the wire enum both ways", () => {
    expect(MODE_NAME[MODE.OFF]).toBe("OFF");
    expect(MODE_NAME[MODE.RESTRICTED]).toBe("RESTRICTED");
    expect(MODE_NAME[MODE.OPEN]).toBe("OPEN");
  });

  it("shows a tenant's policy with the enum's name", () => {
    const _id = new ObjectId();
    const tenant = {
      _id,
      version: 3,
      oauth: {
        par: { required: true },
        dpop: { required: false },
        agents: {
          dynamic: "restricted",
          redirectUris: [],
          metadataDocuments: false,
          allowHosts: [],
        },
      },
    } as unknown as Tenant;
    const policy = policyOf(tenant);
    expect(policy.tenantId).toBe(_id.toHexString());
    expect(policy.par).toEqual({ required: true });
    expect(policy.agents.dynamic).toBe("RESTRICTED");
    expect(policy.version).toBe(3);
    expect(typeof policy.agentsNeedPushOrProof).toBe("boolean");
  });
});
