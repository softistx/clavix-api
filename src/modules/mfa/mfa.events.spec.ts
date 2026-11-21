import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eventBus } from "@/config/events";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { recordOf } from "~/narrow";
import { contextOf, tenantStandIn } from "~/spec-context";
import { recordStepUp } from "./mfa.events";

const ctxOf = (tenant: ResolvedTenant | null) => contextOf({ tenant });

describe("recordStepUp", () => {
  afterEach(() => {
    spyOn(eventBus, "emit").mockRestore();
  });

  test("records a success without a reason", async () => {
    const emit = spyOn(eventBus, "emit").mockResolvedValue(undefined);
    await recordStepUp(ctxOf(tenantStandIn()), "totp", "u1");
    const event = recordOf(emit.mock.calls[0]?.[0]);
    expect(event["type"]).toBe("stepUp.confirm");
    expect(event["outcome"]).toBe("success");
    expect("reason" in event).toBe(false);
    expect(event["userId"]).toBe("u1");
  });

  test("records a failure with its reason", async () => {
    const emit = spyOn(eventBus, "emit").mockResolvedValue(undefined);
    await recordStepUp(ctxOf(tenantStandIn()), "totp", "u1", {
      extensions: { code: "CODE_INVALID" },
    });
    const event = recordOf(emit.mock.calls[0]?.[0]);
    expect(event["outcome"]).toBe("failure");
    expect(event["reason"]).toBe("CODE_INVALID");
  });

  test("emits nothing without a tenant", async () => {
    const emit = spyOn(eventBus, "emit").mockResolvedValue(undefined);
    await recordStepUp(ctxOf(null), "totp", "u1");
    expect(emit).not.toHaveBeenCalled();
  });
});
