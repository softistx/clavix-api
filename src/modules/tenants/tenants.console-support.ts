import { NotFoundError } from "@softistx/mongo";
import { tenantsService } from "@/config/tenancy";
import { refusal } from "@/console/modules/refusal";
import { badInput, fail } from "@/shared/errors";
import type { TenantParent } from "./tenants.console-parent";
import type { Tenant } from "./tenants.model";
import {
  type effectiveQuotas,
  isPlanId,
  type PlanId,
  QUOTA_KEYS,
  type QuotaOverrides,
} from "./tenants.plan";
import type { TenantState } from "./tenants.types";

export const notFound = () =>
  fail("NOT_FOUND", "No such tenant", { status: 404 });

// The stored tenant of a parent: the one it carries, else read once.
export async function docOf(parent: TenantParent): Promise<Tenant> {
  parent.doc ??= await tenantsService.get(parent.id).catch((error: unknown) => {
    throw error instanceof NotFoundError ? notFound() : error;
  });
  return parent.doc;
}

// A tenant the caller may write to: it exists and is not in the trash.
export async function writable(id: string): Promise<Tenant> {
  const tenant = await tenantsService.find(id.toLowerCase());
  if (tenant === undefined || tenant.deletedAt !== null) throw notFound();
  return tenant;
}

// The service's `NotFoundError` as the contract's NOT_FOUND.
export const asNotFound = (error: unknown) =>
  error instanceof NotFoundError ? notFound() : refusal(error);

export const STATE = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const satisfies Record<string, TenantState>;

export const quotasOut = (quotas: ReturnType<typeof effectiveQuotas>) => ({
  ...quotas,
});

export const STATUS = {
  active: "ACTIVE",
  suspended: "SUSPENDED",
  deleted: "DELETED",
} as const satisfies Record<TenantState, string>;

export function planOrFail(plan: string): PlanId {
  if (!isPlanId(plan)) throw badInput(`Unknown plan "${plan}"`, "plan");
  return plan;
}

export function overridesOrFail(
  input:
    | {
        mau?: number | null;
        clients?: number | null;
        domains?: number | null;
        agents?: number | null;
        webhooks?: number | null;
        connections?: number | null;
      }
    | null
    | undefined,
): QuotaOverrides {
  const overrides: QuotaOverrides = {};
  for (const key of QUOTA_KEYS) {
    const value = input?.[key];
    if (value === null || value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw badInput(`${key} must be 0 or more`, `quotaOverrides.${key}`);
    }
    overrides[key] = value;
  }
  return overrides;
}
