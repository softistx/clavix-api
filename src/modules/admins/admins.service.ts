import type { Exclusive } from "@/console/exclusive";
import { ROLES, type Role } from "@/console/model";
import { fail } from "@/shared/errors";
import { alreadyMember, lastOwnerError } from "./admins.errors";
import type {
  AdminsDirectory,
  AdminsServiceOptions,
  Member,
} from "./admins.types";
import { membersKey, roleOf } from "./admins.utils";

/**
 * The console's roles: who holds which on a tenant or on the platform, and the
 * writes of a tenant's memberships. The relation store has no conditional
 * write, so every membership write runs under the tenant's `membersKey`
 * (`Exclusive`). Built by the console's plugin over its own ports
 * (`ctx.members`).
 */
export class AdminsService {
  private readonly access: AdminsServiceOptions["access"];
  private readonly directory: AdminsDirectory;
  private readonly exclusive: Exclusive;

  constructor({ access, directory, exclusive }: AdminsServiceOptions) {
    this.access = access;
    this.directory = directory;
    this.exclusive = exclusive;
  }

  /**
   * The one owner rule, for every write: an owner counts only while they exist
   * and can sign in. How many of `owners` but `userId` do; the change that
   * makes it 0 for the last one is `LAST_OWNER`.
   */
  async otherLiveOwners(
    owners: readonly string[],
    userId: string,
  ): Promise<number> {
    let live = 0;
    for (const owner of owners) {
      if (owner === userId) continue;
      if ((await this.directory.findUser(owner))?.active === true) live++;
    }
    return live;
  }

  /** The role a user holds directly on the tenant (the strongest), or `null`. */
  roleOf(tenantId: string, userId: string): Promise<Role | null> {
    return roleOf(this.access, tenantId, userId);
  }

  /** The tenant's members, owners first. A user who is gone is left out. */
  members(tenantId: string): Promise<Member[]> {
    return this.collect((role) => this.access.holders(tenantId, role));
  }

  /** The platform's operators, owners first, one entry per user (the strongest role). A user who is gone is left out. */
  platformOperators(): Promise<Member[]> {
    return this.collect((role) => this.access.platformHolders(role));
  }

  /**
   * Gives a member another role, one change of the tenant's memberships at a
   * time. `NOT_FOUND` for a user who is not a member, `LAST_OWNER` when it
   * would leave no owner. Answers the role as stored.
   */
  changeRole(tenantId: string, userId: string, role: Role): Promise<Role> {
    return this.exclusive(membersKey(tenantId), async () => {
      if ((await this.roleOf(tenantId, userId)) === null) {
        throw fail("NOT_FOUND", "Not a member of this tenant", { status: 404 });
      }
      await this.setRole(tenantId, userId, role);
      return (await this.roleOf(tenantId, userId)) ?? role;
    });
  }

  /** Removes a member (a non-member is left as is); `LAST_OWNER` for the last owner who can sign in. */
  removeMember(tenantId: string, userId: string): Promise<void> {
    return this.exclusive(membersKey(tenantId), () =>
      this.setRole(tenantId, userId, null),
    );
  }

  /** `ALREADY_MEMBER` when the user already holds a role on the tenant. */
  async assertNotMember(tenantId: string, userId: string): Promise<void> {
    if ((await this.roleOf(tenantId, userId)) !== null) {
      throw alreadyMember();
    }
  }

  /** The users holding a role, owners first, one entry each (the strongest role wins), a user who is gone left out. */
  private async collect(
    holdersOf: (role: Role) => Promise<readonly string[]>,
  ): Promise<Member[]> {
    const found: Member[] = [];
    const seen = new Set<string>();
    for (const role of ROLES) {
      for (const userId of await holdersOf(role)) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        const user = await this.directory.findUser(userId);
        if (user !== null) found.push({ user, role });
      }
    }
    return found;
  }

  /**
   * Gives the user exactly `role` on the tenant (the others are revoked), or
   * none, unless that leaves the tenant with no owner. The check and the
   * writes only hold together under the tenant's `membersKey`: call it
   * through `changeRole` / `removeMember`, never bare.
   */
  private async setRole(
    tenantId: string,
    userId: string,
    role: Role | null,
  ): Promise<void> {
    const owners = await this.access.holders(tenantId, "owner");
    if (
      role !== "owner" &&
      owners.includes(userId) &&
      (await this.otherLiveOwners(owners, userId)) === 0
    ) {
      throw lastOwnerError();
    }
    if (role !== null) await this.access.grantTenant(tenantId, userId, role);
    for (const other of ROLES) {
      if (other !== role)
        await this.access.revokeTenant(tenantId, userId, other);
    }
  }
}
