import type { Role } from "@/console/model";

/** The GraphQL spelling of each role. */
export const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;

/** The stored spelling of each GraphQL role. */
export const ROLE_OF = {
  OWNER: "owner",
  ADMIN: "admin",
  VIEWER: "viewer",
} as const;

/** The `Exclusive` key of a tenant's memberships: every write of them runs under it. */
export const membersKey = (tenantId: string) => `console:members:${tenantId}`;

/** The `Exclusive` key of the platform owners: the check of the last one runs under it. */
export const PLATFORM_OWNERS_KEY = "console:platform-owners";

/** One resend of an invitation at a time (the cooldown check and the write). */
export const resendKey = (tenantId: string, invitationId: string) =>
  `console:resend:${tenantId}:${invitationId}`;

/** A member as the console shows it. */
export const memberOf = (
  user: { id: string; email: string; name?: string | undefined },
  role: Role,
) => ({
  user: { id: user.id, email: user.email, name: user.name ?? null },
  role: GRAPHQL_ROLE[role],
});

/** An invitation with its role spelled for GraphQL and its inviter named from `names`. */
export const shapeInvitation = <
  I extends { role: Role; invitedBy: string | null },
>(
  { invitedBy, role, ...invitation }: I,
  names: ReadonlyMap<string, string | null>,
) => ({
  ...(invitation as Omit<I, "role" | "invitedBy">),
  role: GRAPHQL_ROLE[role],
  invitedBy:
    invitedBy === null
      ? null
      : { id: invitedBy, name: names.get(invitedBy) ?? null },
});
