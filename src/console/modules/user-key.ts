/** The `Exclusive` key of one user of a tenant: what changes the user or their role assignments runs alone under it. */
export const userKey = (tenantId: string, userId: string) =>
  `console:user:${tenantId}:${userId}`;
