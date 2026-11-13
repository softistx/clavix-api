const ADMIN = "admin:";

/**
 * The scope of an invitation to administer a tenant (a console role on it),
 * issued in the `clavix` tenant. Any other scope is an invitation into a
 * tenant's own user pool and grants no console role.
 */
export const adminScope = (tenantId: string) => `${ADMIN}${tenantId}`;

/** The tenant an admin invitation's scope names, or `null` for any other scope. */
export const adminTenantOf = (scope: string): string | null =>
  scope.startsWith(ADMIN) ? scope.slice(ADMIN.length) : null;

/**
 * The scope of an invitation into a tenant's own user pool, issued by that
 * tenant's console admins. Accepting it makes the account and grants nothing else.
 */
export const userScope = () => "users";
