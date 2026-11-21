import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import { GraphQLError } from "graphql";
import { instance } from "~/narrow";
import {
  codes,
  goneCode,
  guarded,
  invalid,
  ResendRefusedError,
  TenantUnavailableError,
} from "./invitations.errors";

const janusError = (code: JanusError["code"]) =>
  Object.assign(new JanusError(code), { code });

describe("invitations errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("invitations");
    expect([...codes.codes]).toEqual([
      "INVITATION_INVALID",
      "INVITATION_NOT_PENDING",
      "RESEND_TOO_SOON",
      "INVITE_TOO_SOON",
      "PENDING_INVITATIONS_LIMIT",
    ]);
  });

  test("invalid is a 400 INVITATION_INVALID", () => {
    const error = invalid();
    expect(error.extensions["code"]).toBe("INVITATION_INVALID");
    expect(error.extensions["http"]).toEqual({ status: 400 });
  });

  test("guarded answers every janus refusal alike, but not a store failure", async () => {
    for (const code of [
      "NOT_FOUND",
      "TOKEN_SPENT",
      "INVITATION_NOT_PENDING",
    ] as const) {
      const refused = await guarded(async () => {
        throw janusError(code);
      }).catch((e: unknown) => e);
      expect(instance(refused, GraphQLError).extensions["code"]).toBe(
        "INVITATION_INVALID",
      );
    }
    const store = janusError("STORE_FAILED");
    await expect(
      guarded(async () => {
        throw store;
      }),
    ).rejects.toBe(store);
    expect(await guarded(async () => 5)).toBe(5);
  });

  test("goneCode names only the two janus codes", () => {
    expect(goneCode(janusError("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(goneCode(janusError("INVITATION_NOT_PENDING"))).toBe(
      "INVITATION_NOT_PENDING",
    );
    expect(goneCode(janusError("STORE_FAILED"))).toBeNull();
    expect(goneCode(new Error("x"))).toBeNull();
  });

  test("the refusal and unavailable errors carry their code", () => {
    const refused = new ResendRefusedError("RESEND_TOO_SOON", 7);
    expect([refused.code, refused.retryAfter]).toEqual(["RESEND_TOO_SOON", 7]);
    expect(new TenantUnavailableError().name).toBe("TenantUnavailableError");
  });
});
