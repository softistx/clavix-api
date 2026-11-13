import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import {
  createTenantInvitations,
  type InvitationSource,
} from "./tenant-invitations";

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const stored = (id: string, scope: string) => ({
  id,
  scope,
  email: `${id}@inv.test`,
  role: "member",
  createdAt: at(1),
  expiresAt: at(8),
});

// A janus refusal with this code (janus makes them through its subclasses).
const janusError = (code: JanusError["code"]) =>
  Object.assign(new JanusError(code), { code });

function fakeSource(pageSize = 2) {
  const kept = [stored("1", "s"), stored("2", "s"), stored("3", "s")];
  const mails: { to: string; data: Record<string, unknown> }[] = [];
  const revoked: string[] = [];
  let failWith: unknown = null;
  const source: InvitationSource = {
    auth: {
      invitations: {
        issue: async (input) => ({
          code: "c o/de",
          invitation: { ...stored("9", input.scope), ...input },
        }),
        list: async (scope, page) => {
          const all = kept.filter((invitation) => invitation.scope === scope);
          const from = page.after === null ? 0 : Number(page.after);
          const next = from + pageSize;
          return {
            items: all.slice(from, next),
            nextCursor: next < all.length ? String(next) : null,
          };
        },
        revoke: async ({ id }) => {
          if (failWith !== null) throw failWith;
          revoked.push(id);
        },
      },
    },
    mail: {
      invitation: async (to, data) => {
        mails.push({ to: to.email, data: { ...data } });
      },
    },
    link: (code) =>
      `https://t.test/invitation?code=${encodeURIComponent(code)}`,
  };
  return {
    source,
    mails,
    revoked,
    fail: (error: unknown) => {
      failWith = error;
    },
  };
}

describe("createTenantInvitations", () => {
  test("invite issues under the scope and mails the link of the code", async () => {
    const { source, mails } = fakeSource();
    const invitations = createTenantInvitations(async () => source);
    const invited = await invitations.invite({
      scope: "s",
      organization: "Acme",
      email: "new@inv.test",
      role: "member",
      invitedBy: { id: "u1", name: "Ann" },
    });
    expect(invited).toEqual({
      id: "9",
      email: "new@inv.test",
      role: "member",
      invitedAt: at(1),
      expiresAt: at(8),
    });
    expect(mails).toEqual([
      {
        to: "new@inv.test",
        data: {
          inviter: "Ann",
          organization: "Acme",
          role: "member",
          link: "https://t.test/invitation?code=c%20o%2Fde",
          expiresAt: at(8),
        },
      },
    ]);
  });

  test("pending reads every page of its scope only", async () => {
    const { source } = fakeSource(2);
    const invitations = createTenantInvitations(async () => source);
    expect((await invitations.pending("s")).map(({ id }) => id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(await invitations.pending("other")).toEqual([]);
  });

  test("revoke is false for an invitation that is not a pending one of the scope, and rethrows the rest", async () => {
    const { source, revoked, fail } = fakeSource();
    const invitations = createTenantInvitations(async () => source);
    expect(await invitations.revoke("s", "1")).toBe(true);
    expect(revoked).toEqual(["1"]);
    for (const code of ["NOT_FOUND", "INVITATION_NOT_PENDING"] as const) {
      fail(janusError(code));
      expect(await invitations.revoke("s", "1")).toBe(false);
    }
    fail(janusError("STORE_FAILED"));
    expect(invitations.revoke("s", "1")).rejects.toThrow("STORE_FAILED");
  });

  test("a tenant that is missing or suspended makes every call throw", async () => {
    const invitations = createTenantInvitations(async () => null);
    expect(invitations.pending("s")).rejects.toThrow("not available");
    expect(invitations.revoke("s", "1")).rejects.toThrow("not available");
  });
});
