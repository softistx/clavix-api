import { describe, expect, test } from "bun:test";
import { emptySecretResealCounts } from "@/modules/sign-in-methods";
import {
  emptyResealCounts,
  encryptionKeyOf,
  errorText,
  pendingCounts,
  resealExitCode,
  sealKeyId,
} from "./keys.utils";

describe("encryptionKeyOf", () => {
  test("a lone key stays as it is, a keyring becomes a list", () => {
    const key = new Uint8Array(32).fill(1);
    expect(encryptionKeyOf(key)).toBe(key);
    expect(encryptionKeyOf([key])).toEqual([key]);
  });
});

describe("errorText", () => {
  test("is the message of an error, the text of anything else", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
  });
});

describe("sealKeyId", () => {
  test("reads the key id of a v1 sealed value, nothing of any other text", () => {
    expect(sealKeyId("v1.kid.iv.cipher")).toBe("kid");
    expect(sealKeyId("v2.kid.iv.cipher")).toBeNull();
    expect(sealKeyId("plain")).toBeNull();
    expect(sealKeyId(42)).toBeNull();
  });
});

describe("the reseal counts", () => {
  test("a fresh report has nothing pending and exits 0", () => {
    const counts = emptyResealCounts();
    expect(counts.secondFactor).toEqual({
      scanned: 0,
      resealed: 0,
      current: 0,
      skipped: 0,
      unreadable: 0,
      sealed: 0,
      behind: 0,
      recoveryCodesBehind: 0,
    });
    expect(pendingCounts(counts)).toEqual([]);
    expect(resealExitCode({ ...counts, oldKeyNeededBy: [] })).toBe(0);
  });

  test("a store still behind is pending and fails the exit code; recovery codes alone do not", () => {
    const counts = emptyResealCounts();
    counts.webhookSecrets = { ...emptySecretResealCounts(), behind: 2 };
    expect(pendingCounts(counts)).toEqual([["webhookSecrets.behind", 2]]);
    expect(resealExitCode({ ...counts, oldKeyNeededBy: [] })).toBe(1);

    const codes = emptyResealCounts();
    codes.secondFactor.recoveryCodesBehind = 3;
    expect(pendingCounts(codes)).toEqual([
      ["secondFactor.recoveryCodesBehind", 3],
    ]);
    expect(resealExitCode({ ...codes, oldKeyNeededBy: [] })).toBe(0);
  });
});
