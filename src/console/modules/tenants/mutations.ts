import { tenantAdmin, tenantBySlug, tenantsService } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  isPlanId,
  type PlanId,
  QUOTA_KEYS,
  type QuotaOverrides,
} from "@/modules/tenants/plan.schema";
import { SlugTakenError } from "@/modules/tenants/tenants.errors";
import { badInput, refusal } from "./errors";
import { asNotFound, notFound, writable } from "./lookup";
import { parentOf } from "./parent";

function planOrFail(plan: string): PlanId {
  if (!isPlanId(plan)) throw badInput(`Unknown plan "${plan}"`, "plan");
  return plan;
}

function overridesOrFail(
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

export const tenantMutations: NonNullable<Resolvers["Mutation"]> = {
  createTenant: async (_, { input }, ctx) => {
    const plan =
      input.plan === null || input.plan === undefined
        ? "free"
        : planOrFail(input.plan);
    const wanted = {
      slug: input.slug,
      name: input.name,
      ...(input.signUp === null || input.signUp === undefined
        ? {}
        : { signUp: input.signUp }),
      plan,
    };
    const created = await tenantsService
      .create(wanted)
      .catch(async (error: unknown) => {
        if (error instanceof TypeError) throw badInput(error.message, "name");
        // A repeat of a call whose record failed: the same tenant is
        // returned, and its event recorded below.
        if (error instanceof SlugTakenError) {
          const existing = await tenantBySlug(input.slug);
          if (
            existing !== undefined &&
            existing.name === input.name.trim() &&
            existing.plan === plan &&
            existing.signUp === (wanted.signUp ?? false)
          ) {
            return existing;
          }
        }
        throw refusal(error);
      });
    const tenantId = created._id.toHexString();
    await ctx.audit("tenant.create", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(created);
  },
  updateTenant: async (_, { id, input }, ctx) => {
    const current = await writable(id);
    // A suspended tenant's own admins never get here: the guard refuses them.
    const updated = await tenantAdmin
      .update(current._id, {
        name: input.name ?? undefined,
        signUp: input.signUp ?? undefined,
      })
      .catch((error: unknown) => {
        if (error instanceof TypeError) throw badInput(error.message, "name");
        throw asNotFound(error);
      });
    const tenantId = updated._id.toHexString();
    await ctx.audit("tenant.update", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(updated);
  },
  setTenantPlan: async (_, { id, input }, ctx) => {
    const plan = planOrFail(input.plan);
    const quotaOverrides = overridesOrFail(input.quotaOverrides);
    const current = await writable(id);
    const updated = await tenantAdmin
      .setPlan(current._id, { plan, quotaOverrides })
      .catch((error: unknown) => {
        throw asNotFound(error);
      });
    const tenantId = updated._id.toHexString();
    await ctx.audit("tenant.setPlan", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(updated);
  },
  suspendTenant: async (_, { id }, ctx) => {
    const current = await writable(id);
    const updated = await tenantsService
      .suspend(current._id)
      .catch((error: unknown) => {
        throw asNotFound(error);
      });
    const tenantId = updated._id.toHexString();
    await ctx.audit("tenant.suspend", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(updated);
  },
  resumeTenant: async (_, { id }, ctx) => {
    const current = await writable(id);
    const updated = await tenantsService
      .reactivate(current._id)
      .catch((error: unknown) => {
        throw asNotFound(error);
      });
    const tenantId = updated._id.toHexString();
    await ctx.audit("tenant.resume", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(updated);
  },
  deleteTenant: async (_, { id: given }, ctx) => {
    const id = given.toLowerCase();
    const current = await tenantAdmin.find(id);
    if (current === undefined) throw notFound();
    const deleted = await tenantAdmin.trash(id).catch((error: unknown) => {
      throw asNotFound(error);
    });
    const tenantId = deleted._id.toHexString();
    await ctx.audit("tenant.delete", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(deleted);
  },
  restoreTenant: async (_, { id }, ctx) => {
    const restored = await tenantAdmin
      .restore(id.toLowerCase())
      .catch((error: unknown) => {
        throw asNotFound(error);
      });
    const tenantId = restored._id.toHexString();
    await ctx.audit("tenant.restore", {
      type: "tenant",
      id: tenantId,
      tenantId,
    });
    return parentOf(restored);
  },
};
