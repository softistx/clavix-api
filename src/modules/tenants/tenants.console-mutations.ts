import { tenantBySlug, tenantsService } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import { SlugTakenError } from "@/modules/tenants";
import { badInput, refusal } from "./tenants.console-errors";
import { parentOf } from "./tenants.console-parent";
import {
  asNotFound,
  notFound,
  overridesOrFail,
  planOrFail,
  writable,
} from "./tenants.console-support";

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
    const updated = await tenantsService
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
    const updated = await tenantsService
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
    const current = await tenantsService.find(id);
    if (current === undefined) throw notFound();
    const deleted = await tenantsService.trash(id).catch((error: unknown) => {
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
    const restored = await tenantsService
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
