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

const OPERATOR = "operator";

/**
 * The scope of an invitation to become a platform operator, issued in the
 * `clavix` tenant by `operators:grant --create`. Accepting it makes the account
 * and grants the invitation's role on the platform.
 */
export const operatorScope = () => OPERATOR;

/** Whether the scope is the operator invitation one. */
export const isOperatorScope = (scope: string): boolean => scope === OPERATOR;
