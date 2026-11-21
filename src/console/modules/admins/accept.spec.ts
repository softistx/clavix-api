import { describe, expect, test } from "bun:test";
import { adminScope, operatorScope } from "@/modules/invitations/scope";
import { createExclusive } from "../../exclusive";
import { adminInvitationHooks } from "./accept";

const TENANT = "6553f1c2a1b2c3d4e5f60718";

const lockOf = (id: string) => `console:user:platform:${id}`;

function setup(known: Record<string, boolean>) {
  const exclusive = createExclusive();
  const granted: [string, string, string][] = [];
  const platform: [string, string][] = [];
  const hooks = adminInvitationHooks({
    access: {
      holders: async () => [],
      grantTenant: async (t: string, u: string, r: string) => {
        granted.push([t, u, r]);
      },
      grantPlatform: async (u: string, r: string) => {
        platform.push([u, r]);
      },
      platformRole: async () => null,
    },
    exclusive,
    userLock: lockOf,
    tenantActive: async () => true,
    findUser: async (id: string) =>
      id in known ? { active: known[id] ?? false } : null,
  } as never);
  return { hooks, granted, platform, exclusive };
}

const invitation = (
  role: string,
  invitedBy: string | null,
  scope = adminScope(TENANT),
) => ({ scope, role, invitedBy }) as { scope: string; role: string };

describe("an owner invitation accepted after a deletion", () => {
  test("refused before anything is written when its inviter is gone", async () => {
    const { hooks } = setup({ new: true });
    expect(
      await hooks.beforeAccept({ invitation: invitation("owner", "gone") }),
    ).toBe(false);
  });

  test("refused too when its inviter is disabled", async () => {
    const { hooks } = setup({ off: false });
    expect(
      await hooks.beforeAccept({ invitation: invitation("owner", "off") }),
    ).toBe(false);
  });

  test("a live inviter, or a system invitation, is accepted", async () => {
    const { hooks } = setup({ boss: true, new: true });
    expect(
      await hooks.beforeAccept({ invitation: invitation("owner", "boss") }),
    ).toBe(true);
    expect(
      await hooks.beforeAccept({ invitation: invitation("owner", null) }),
    ).toBe(true);
  });

  test("no owner is granted to an account that was deleted meanwhile", async () => {
    const { hooks, granted } = setup({});
    await expect(
      hooks.onAccepted({
        invitation: invitation("owner", null),
        user: { id: "gone" },
      }),
    ).rejects.toThrow();
    expect(granted).toEqual([]);
  });

  test("nor to a disabled one; an admin role is not affected", async () => {
    const { hooks, granted } = setup({ off: false });
    await expect(
      hooks.onAccepted({
        invitation: invitation("owner", null),
        user: { id: "off" },
      }),
    ).rejects.toThrow();
    await hooks.onAccepted({
      invitation: invitation("admin", null),
      user: { id: "off" },
    });
    expect(granted).toEqual([[TENANT, "off", "admin"]]);
  });

  test("the platform owner invitation is checked the same way", async () => {
    const { hooks, platform } = setup({});
    await expect(
      hooks.onAccepted({
        invitation: invitation("owner", null, operatorScope()),
        user: { id: "gone" },
      }),
    ).rejects.toThrow();
    expect(platform).toEqual([]);
  });
});

describe("an accept racing a deleteUser", () => {
  /** deleteUser's step: the account goes, then its roles, under the user lock. */
  const deleting = (
    exclusive: ReturnType<typeof createExclusive>,
    known: Record<string, boolean>,
    id: string,
    sweep: () => void,
  ) =>
    exclusive(lockOf(id), async () => {
      delete known[id];
      sweep();
      // Still holding the lock: the delete has not returned yet.
      await new Promise((r) => setTimeout(r, 20));
    });

  test("an admin role is not granted to the account being deleted", async () => {
    const known: Record<string, boolean> = { vic: true };
    const { hooks, granted, exclusive } = setup(known);
    const gone = deleting(exclusive, known, "vic", () => {
      granted.length = 0;
    });
    await expect(
      hooks.onAccepted({
        invitation: invitation("admin", null),
        user: { id: "vic" },
      }),
    ).rejects.toThrow();
    await gone;
    expect(granted).toEqual([]);
  });

  test("nor a platform role (an operator invitation)", async () => {
    const known: Record<string, boolean> = { vic: true };
    const { hooks, platform, exclusive } = setup(known);
    const gone = deleting(exclusive, known, "vic", () => {
      platform.length = 0;
    });
    await expect(
      hooks.onAccepted({
        invitation: invitation("admin", null, operatorScope()),
        user: { id: "vic" },
      }),
    ).rejects.toThrow();
    await gone;
    expect(platform).toEqual([]);
  });

  test("an accept that wins the lock is swept by the delete after it", async () => {
    const known: Record<string, boolean> = { vic: true };
    const { hooks, granted, exclusive } = setup(known);
    await hooks.onAccepted({
      invitation: invitation("admin", null),
      user: { id: "vic" },
    });
    expect(granted).toHaveLength(1);
    await deleting(exclusive, known, "vic", () => {
      granted.length = 0;
    });
    expect(granted).toEqual([]);
  });
});

describe("an accept racing a disableUser", () => {
  test("an owner is not granted to an account disabled under the user lock", async () => {
    const known: Record<string, boolean> = { vic: true };
    const { hooks, granted, exclusive } = setup(known);
    const disabling = exclusive(lockOf("vic"), async () => {
      await new Promise((r) => setTimeout(r, 20));
      known["vic"] = false;
    });
    await expect(
      hooks.onAccepted({
        invitation: invitation("owner", null),
        user: { id: "vic" },
      }),
    ).rejects.toThrow();
    await disabling;
    expect(granted).toEqual([]);
  });
});
