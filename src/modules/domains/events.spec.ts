import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { AUDIT_ACTION } from "@/console/audit";
import { domainEventInput } from "./events";

const tenantId = new ObjectId();
const domainId = new ObjectId();

describe("domainEventInput", () => {
  test("a lapse is the recheck's, an eviction the verification's", () => {
    const lapse = domainEventInput({
      action: "domain.lapse",
      tenantId,
      domainId,
    });
    const evict = domainEventInput({
      action: "domain.evict",
      tenantId,
      domainId,
    });
    expect(lapse).toMatchObject({
      actor: "system:domains:recheck",
      action: "domain.lapse",
      tenantId: tenantId.toHexString(),
      target: { type: "domain", id: domainId.toHexString() },
    });
    expect(evict.actor).toBe("system:domains:verify");
    expect(AUDIT_ACTION.test(lapse.action)).toBe(true);
    expect(AUDIT_ACTION.test(evict.action)).toBe(true);
  });

  test("each event has its own request id", () => {
    const one = domainEventInput({
      action: "domain.lapse",
      tenantId,
      domainId,
    });
    const two = domainEventInput({
      action: "domain.lapse",
      tenantId,
      domainId,
    });
    expect(one.requestId).not.toBe(two.requestId);
  });
});
