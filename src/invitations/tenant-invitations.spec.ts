import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import {
  createTenantInvitations,
  type InvitationSource,
  ResendRefusedError,
} from "./tenant-invitations";

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const stored = (id: string, scope: string) => ({
  id,
  scope,
  email: `${id}@inv.test`,
  role: "member",
  createdAt: at(1),
  updatedAt: at(1),
  expiresAt: at(8),
  invitedBy: null,
});

// A janus refusal with this code (janus makes them through its subclasses).
const janusError = (code: JanusError["code"]) =>
  Object.assign(new JanusError(code), { code });

function fakeSource(pageSize = 2) {
  const kept = [stored("1", "s"), stored("2", "s"), stored("3", "s")];
  const status = new Map<string, "pending" | "accepted" | "revoked">();
  const resent: { id: string; by: string | undefined }[] = [];
  const mails: { to: string; data: Record<string, unknown> }[] = [];
  const revoked: string[] = [];
  let failWith: unknown = null;
  const source: InvitationSource = {
    auth: {
      invitations: {
        issue: async (input) => ({
          code: "c o/de",
          invitation: {
            ...stored("9", input.scope),
            ...input,
            invitedBy: input.invitedBy?.id ?? null,
          },
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
        get: async ({ id, scope }) => {
          const found = kept.find((i) => i.id === id && i.scope === scope);
          return found === undefined
            ? null
            : { ...found, status: status.get(id) ?? "pending" };
        },
        resend: async ({ id, scope, by }) => {
          if (failWith !== null) throw failWith;
          resent.push({ id, by });
          return {
            code: "new/code",
            invitation: { ...stored(id, scope), expiresAt: at(20) },
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
    resent,
    status,
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
      invitedBy: "u1",
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

  describe("resend", () => {
    const input = {
      scope: "s",
      invitationId: "1",
      organization: "Acme",
      by: { id: "u2", name: "Bob" },
    };
    // The fixtures were last written on day 1.
    const clock = (seconds: number) => () => at(1).getTime() + seconds * 1000;

    test("renews the invitation, mails the new link in the sender's name, keeps invitedBy", async () => {
      const { source, mails, resent } = fakeSource();
      const invitations = createTenantInvitations(async () => source, {
        now: clock(61),
      });
      const sent = await invitations.resend(input);
      expect(sent).toMatchObject({ id: "1", expiresAt: at(20) });
      expect(resent).toEqual([{ id: "1", by: "u2" }]);
      expect(mails).toEqual([
        {
          to: "1@inv.test",
          data: {
            inviter: "Bob",
            organization: "Acme",
            role: "member",
            link: "https://t.test/invitation?code=new%2Fcode",
            expiresAt: at(20),
          },
        },
      ]);
    });

    test("is refused within the cooldown, with the seconds left, and sends nothing", async () => {
      const { source, mails, resent } = fakeSource();
      const invitations = createTenantInvitations(async () => source, {
        now: clock(45),
      });
      const refused = await invitations.resend(input).catch((e) => e);
      expect(refused).toBeInstanceOf(ResendRefusedError);
      expect(refused).toMatchObject({
        code: "RESEND_TOO_SOON",
        retryAfter: 15,
      });
      expect(resent).toEqual([]);
      expect(mails).toEqual([]);
    });

    test("is refused for an unknown id, another scope's id and a settled invitation", async () => {
      const { source, status } = fakeSource();
      const invitations = createTenantInvitations(async () => source, {
        now: clock(120),
      });
      for (const given of [
        { ...input, invitationId: "nope" },
        { ...input, scope: "other" },
      ]) {
        expect(await invitations.resend(given).catch((e) => e.code)).toBe(
          "NOT_FOUND",
        );
      }
      for (const settled of ["accepted", "revoked"] as const) {
        status.set("1", settled);
        expect(await invitations.resend(input).catch((e) => e.code)).toBe(
          "INVITATION_NOT_PENDING",
        );
      }
    });

    test("a settle between the read and the write is the same refusal; other failures pass", async () => {
      const { source, fail } = fakeSource();
      const invitations = createTenantInvitations(async () => source, {
        now: clock(120),
      });
      fail(janusError("INVITATION_NOT_PENDING"));
      expect(await invitations.resend(input).catch((e) => e.code)).toBe(
        "INVITATION_NOT_PENDING",
      );
      fail(janusError("STORE_FAILED"));
      expect(invitations.resend(input)).rejects.toThrow("STORE_FAILED");
    });
  });

  test("a tenant that is missing or suspended makes every call throw", async () => {
    const invitations = createTenantInvitations(async () => null);
    expect(invitations.pending("s")).rejects.toThrow("not available");
    expect(invitations.revoke("s", "1")).rejects.toThrow("not available");
    expect(
      invitations.resend({
        scope: "s",
        invitationId: "1",
        organization: "A",
        by: { id: "u" },
      }),
    ).rejects.toThrow("not available");
  });
});
