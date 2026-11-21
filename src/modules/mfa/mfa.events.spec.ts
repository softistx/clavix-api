import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eventBus } from "@/config/events";
import { recordStepUp } from "./mfa.events";

const ctxOf = (tenant: { tenantId: string } | null) =>
  ({
    ip: "198.51.100.9",
    request: new Request("https://acme.example/graphql"),
    tenant: async () => tenant,
  }) as never;

describe("recordStepUp", () => {
  afterEach(() => {
    spyOn(eventBus, "emit").mockRestore();
  });

  test("records a success without a reason", async () => {
    const emit = spyOn(eventBus, "emit").mockResolvedValue(undefined as never);
    await recordStepUp(ctxOf({ tenantId: "t1" }), "totp" as never, "u1");
    const event = emit.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(event["type"]).toBe("stepUp.confirm");
    expect(event["outcome"]).toBe("success");
    expect("reason" in event).toBe(false);
    expect(event["userId"]).toBe("u1");
  });

  test("records a failure with its reason", async () => {
    const emit = spyOn(eventBus, "emit").mockResolvedValue(undefined as never);
    await recordStepUp(ctxOf({ tenantId: "t1" }), "totp" as never, "u1", {
      extensions: { code: "CODE_INVALID" },
    });
    const event = emit.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(event["outcome"]).toBe("failure");
    expect(event["reason"]).toBe("CODE_INVALID");
  });

  test("emits nothing without a tenant", async () => {
    const emit = spyOn(eventBus, "emit").mockResolvedValue(undefined as never);
    await recordStepUp(ctxOf(null), "totp" as never, "u1");
    expect(emit).not.toHaveBeenCalled();
  });
});
