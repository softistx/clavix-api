import { describe, expect, test } from "bun:test";
import { contextOf } from "~/spec-context";
import { AccountService } from "./account.service";

// The ports that must not be reached: a host naming no tenant stops first.
const never = async (): Promise<never> => {
  throw new Error("reached a port past the tenant check");
};
const noMail = (): never => {
  throw new Error("reached the mail past the tenant check");
};
const service = new AccountService({
  issuers: { forRequest: async () => null },
  mailOf: noMail,
  profilePolicies: { lockedFor: never },
  values: { checkEditable: never, editableOf: never, save: never },
  exclusive: never,
  now: () => new Date("2026-11-22T00:00:00Z"),
  log: () => {},
});
const ctx = contextOf({ tenant: null });
const notFound = { extensions: { code: "NOT_FOUND" } };

describe("AccountService on a host that names no tenant", () => {
  test("every read is NOT_FOUND and touches no port", async () => {
    await expect(service.profile(ctx, "u1")).rejects.toMatchObject(notFound);
    await expect(service.lockedFields(ctx)).rejects.toMatchObject(notFound);
    await expect(service.attributes(ctx, "u1")).rejects.toMatchObject(notFound);
  });

  test("every write is NOT_FOUND and touches no port", async () => {
    await expect(
      service.updateMyProfile(ctx, { givenName: "Ada" }),
    ).rejects.toMatchObject(notFound);
    await expect(service.setMyAttributeValues(ctx, [])).rejects.toMatchObject(
      notFound,
    );
    await expect(
      service.requestEmailChange(ctx, "a@example.test"),
    ).rejects.toMatchObject(notFound);
    await expect(
      service.confirmEmailChange(ctx, "token"),
    ).rejects.toMatchObject(notFound);
  });
});
