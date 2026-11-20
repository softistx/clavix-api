import { GraphQLError } from "graphql";
import type { TenantUserView, UserGrantView } from "../../context";

/** A user as the console resolvers pass it on: its tenant too, for the fields read afterwards (`secondFactor`). */
export interface TenantUserParent {
  tenantId: string;
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  active: boolean;
  createdAt: Date;
}

export const shape = (
  user: TenantUserView,
  tenantId: string,
): TenantUserParent => ({
  tenantId,
  id: user.id,
  email: user.email,
  name: user.name ?? null,
  emailVerified: user.emailVerified,
  active: user.active,
  createdAt: user.createdAt,
});

export const grantShape = (grant: UserGrantView) => ({
  ...grant,
  scopes: [...grant.scopes],
});

export const badInput = (message: string) =>
  new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
  });

export const target = (type: string, id: string, tenantId: string) => ({
  type,
  id,
  tenantId,
});
