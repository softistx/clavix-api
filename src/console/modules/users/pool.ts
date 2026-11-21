import { denial } from "@softistx/janus-graphql";
import type { OAuthGrants } from "@softistx/janus-oauth";
import type { TenantInvitations } from "@/modules/invitations/tenant-invitations";
import type { TenantJanus } from "@/modules/users/tenant-janus";
import type { TenantUserView } from "../../context";

/** Where `ConsoleUsers` reaches a tenant's pool; `null` for a tenant that is gone or suspended. */
export interface UsersSource {
  janusOf(tenantId: string): Promise<TenantJanus | null>;
  grantsOf(tenantId: string): Promise<OAuthGrants | null>;
  invitationsOf(tenantId: string): TenantInvitations;
}

/** A tenant's pool and OAuth grants, "not found" once the tenant is gone. */
export interface Pool {
  readonly source: UsersSource;
  janus(tenantId: string): Promise<TenantJanus>;
  grants(tenantId: string): Promise<OAuthGrants>;
}

// A tenant suspended or deleted since the resolver checked it: not found, as
// for any other call that names it.
export const gone = () => denial("NOT_FOUND", "No such tenant");

export function poolOf(source: UsersSource): Pool {
  return {
    source,
    async janus(tenantId) {
      const found = await source.janusOf(tenantId);
      if (found === null) throw gone();
      return found;
    },
    async grants(tenantId) {
      const found = await source.grantsOf(tenantId);
      if (found === null) throw gone();
      return found;
    },
  };
}

type PoolUser = NonNullable<Awaited<ReturnType<TenantJanus["findUser"]>>>;

export const view = (user: PoolUser): TenantUserView => ({
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerified,
  active: user.active,
  createdAt: user.createdAt,
});
