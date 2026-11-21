import type { TenantUserView, UserGrantView } from "@/console/context";
import type { TenantJanus } from "./tenant-janus";
import type { TenantUserParent } from "./users.types";

type PoolUser = NonNullable<Awaited<ReturnType<TenantJanus["findUser"]>>>;

export const view = (user: PoolUser): TenantUserView => ({
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerified,
  active: user.active,
  createdAt: user.createdAt,
});

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

export const target = (type: string, id: string, tenantId: string) => ({
  type,
  id,
  tenantId,
});
