import { describe, expect, test } from "bun:test";
import type { TenantInvitations } from "@/modules/invitations/tenant-invitations";
import { TenantUnavailableError } from "@/modules/invitations/tenant-invitations";
import { createJanusUsers } from "./janus-users";

// A tenant suspended or deleted between the console's own check and the call
// is "not found", like any other call that names it, never a plain 500.
const away: TenantInvitations = {
  invite: async () => {
    throw new TenantUnavailableError();
  },
  pending: async () => {
    throw new TenantUnavailableError();
  },
  revoke: async () => {
    throw new TenantUnavailableError();
  },
} as unknown as TenantInvitations;
const users = createJanusUsers({
  janusOf: async () => null,
  grantsOf: async () => null,
  invitationsOf: () => away,
});
const notFound = { extensions: { code: "NOT_FOUND" } };

describe("a tenant that went away mid-request", () => {
  test("its invitations answer NOT_FOUND", async () => {
    await expect(
      users.invite({
        tenantId: "t",
        tenantName: "T",
        email: "a@b.test",
        invitedBy: { id: "u" },
      }),
    ).rejects.toMatchObject(notFound);
    await expect(users.invitations("t")).rejects.toMatchObject(notFound);
    await expect(users.revokeInvitation("t", "i")).rejects.toMatchObject(
      notFound,
    );
  });

  test("its pool and grants answer NOT_FOUND", async () => {
    await expect(users.find("t", "u")).rejects.toMatchObject(notFound);
    await expect(users.delete("t", "u")).rejects.toMatchObject(notFound);
    await expect(users.grants("t", "u")).rejects.toMatchObject(notFound);
  });
});
