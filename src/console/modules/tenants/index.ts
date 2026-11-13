import { denial } from "@softistx/janus-graphql";
import { NotFoundError } from "@softistx/mongo";
import { tenantAdmin, tenantBySlug, tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  effectiveQuotas,
  isPlanId,
  overridesOf,
  PLANS,
  type PlanId,
  planOf,
  QUOTA_KEYS,
  type QuotaOverrides,
} from "@/modules/tenants/plan.schema";
import { stateOf, type TenantState } from "@/modules/tenants/tenants.admin";
import { SlugTakenError } from "@/modules/tenants/tenants.errors";
import type { Tenant } from "@/modules/tenants/tenants.model";
import { purgeAtOf } from "@/modules/tenants/trash.schema";
import { isMonth } from "@/modules/usage/mau";
import type { Audits } from "../../audit";
import { type Guards, onPlatform, onTenant } from "../../guard";
import { tenantArg } from "../ids";
import { badInput, refusal, suspendedForAdmins } from "./errors";
import { parentOf, type TenantParent } from "./parent";

export type { TenantParent } from "./parent";

const idOf = (args: Record<string, unknown>) =>
  String(args["id"]).toLowerCase();

export const tenantsGuards: Guards = {
  "Query.tenants": onPlatform("view"),
  "Query.tenant": onTenant("view", idOf),
  "Query.plans": { kind: "signedIn" },
  "Query.usage": onTenant("view", tenantArg),
  "Mutation.createTenant": onPlatform("edit"),
  "Mutation.updateTenant": onTenant("edit", idOf),
  "Mutation.setTenantPlan": onPlatform("edit"),
  "Mutation.suspendTenant": onPlatform("edit"),
  "Mutation.resumeTenant": onPlatform("edit"),
  "Mutation.deleteTenant": onPlatform("edit"),
  "Mutation.restoreTenant": onPlatform("edit"),
};

export const tenantsAudits: Audits = {
  "Mutation.createTenant": "tenant.create",
  "Mutation.updateTenant": "tenant.update",
  "Mutation.setTenantPlan": "tenant.setPlan",
  "Mutation.suspendTenant": "tenant.suspend",
  "Mutation.resumeTenant": "tenant.resume",
  "Mutation.deleteTenant": "tenant.delete",
  "Mutation.restoreTenant": "tenant.restore",
};

const STATUS = {
  active: "ACTIVE",
  suspended: "SUSPENDED",
  deleted: "DELETED",
} as const satisfies Record<TenantState, string>;
const STATE = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const;

const notFound = () => denial("NOT_FOUND", "No such tenant");
const MAX_PAGE = 100;

// The stored tenant of a parent: the one it carries, else read once.
async function docOf(parent: TenantParent): Promise<Tenant> {
  parent.doc ??= await tenantAdmin.get(parent.id).catch((error: unknown) => {
    throw error instanceof NotFoundError ? notFound() : error;
  });
  return parent.doc;
}

// A tenant the caller may write to: it exists and is not in the trash.
async function writable(id: string): Promise<Tenant> {
  const tenant = await tenantAdmin.find(id.toLowerCase());
  if (tenant === undefined || tenant.deletedAt !== null) throw notFound();
  return tenant;
}

const quotasOut = (quotas: ReturnType<typeof effectiveQuotas>) => ({
  ...quotas,
});

// The service's `NotFoundError` as the contract's NOT_FOUND.
const asNotFound = (error: unknown) =>
  error instanceof NotFoundError ? notFound() : refusal(error);

function planOrFail(plan: string): PlanId {
  if (!isPlanId(plan)) throw badInput(`Unknown plan "${plan}"`, "plan");
  return plan;
}

function overridesOrFail(
  input:
    | { mau?: number | null; clients?: number | null; domains?: number | null }
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

export const tenants: Resolvers = {
  Tenant: {
    status: async (parent) => STATUS[stateOf(await docOf(parent)) ?? "deleted"],
    signUp: async (parent) => (await docOf(parent)).signUp,
    plan: async (parent) => planOf((await docOf(parent)).plan),
    quotaOverrides: async (parent) =>
      overridesOf((await docOf(parent)).quotaOverrides),
    quotas: async (parent) => quotasOut(effectiveQuotas(await docOf(parent))),
    createdAt: async (parent) => (await docOf(parent)).createdAt,
    deletedAt: async (parent) => (await docOf(parent)).deletedAt,
    purgeAt: async (parent) => {
      const { deletedAt } = await docOf(parent);
      return deletedAt === null ? null : purgeAtOf(deletedAt);
    },
  },
  Query: {
    tenants: async (_, { q, status, after, first }) => {
      const page = await tenantAdmin.list({
        q: q ?? undefined,
        state:
          status === null || status === undefined ? undefined : STATE[status],
        after: after ?? undefined,
        first: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
      });
      return { items: page.items.map(parentOf), nextCursor: page.nextCursor };
    },
    tenant: async (_, { id }, ctx) => {
      const tenant = await tenantAdmin.find(id.toLowerCase());
      if (tenant === undefined) return null;
      // The trash is for platform operators.
      if (tenant.deletedAt !== null && !(await ctx.canPlatform("view"))) {
        return null;
      }
      return parentOf(tenant);
    },
    plans: () =>
      PLANS.map((plan) => ({ ...plan, quotas: quotasOut(plan.quotas) })),
    usage: async (_, { tenantId, month }, ctx) => {
      if (month !== null && month !== undefined && !isMonth(month)) {
        throw badInput("month must be YYYY-MM", "month");
      }
      const tenant = await tenantAdmin.find(tenantId.toLowerCase());
      if (
        tenant === undefined ||
        (tenant.deletedAt !== null && !(await ctx.canPlatform("view")))
      ) {
        throw notFound();
      }
      return usageService.report(tenant, month ?? undefined);
    },
  },
  Mutation: {
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
      // A suspended tenant's own admins cannot change it; an operator can.
      if (current.status === "suspended" && !(await ctx.canPlatform("edit"))) {
        throw suspendedForAdmins();
      }
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
  },
};
