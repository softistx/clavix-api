import { describe, expect, test } from "bun:test";
import { adminScope, operatorScope } from "@/invitations/scope";
import { createExclusive } from "../../exclusive";
import { adminInvitationHooks } from "./accept";

const TENANT = "6553f1c2a1b2c3d4e5f60718";

function setup(known: Record<string, boolean>) {
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
    exclusive: createExclusive(),
    tenantActive: async () => true,
    findUser: async (id: string) =>
      id in known ? { active: known[id] ?? false } : null,
  } as never);
  return { hooks, granted, platform };
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
