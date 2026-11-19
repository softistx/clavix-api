import { z } from "zod";

/** The plans of the platform, smallest first. */
export const PLAN_IDS = ["free", "pro", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** What a quota may be put on. `mau` is soft, `clients`, `domains`, `agents` and `webhooks` are hard. */
export const QUOTA_KEYS = [
  "mau",
  "clients",
  "domains",
  "agents",
  "webhooks",
] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];

/** A limit per quota; `null` means no limit. */
export type Quotas = Record<QuotaKey, number | null>;

const override = z.number().int().min(0).optional();

// The plan fields of a tenant, spread into the `tenants` schema. A tenant
// stored before plans existed reads as `free` with no override.
export const planFields = {
  plan: z.enum(PLAN_IDS).default("free"),
  // The quotas set for this tenant alone; a missing key follows the plan.
  quotaOverrides: z
    .object({
      mau: override,
      clients: override,
      domains: override,
      agents: override,
      webhooks: override,
    })
    .default({}),
};

export type QuotaOverrides = Partial<Record<QuotaKey, number | undefined>>;

export interface Plan {
  id: PlanId;
  name: string;
  quotas: Quotas;
  /** How long a tenant's sign-in log and console activity are kept (D16). */
  auditRetentionDays: number;
}

/** How long the platform's own events (`tenantId: null`) are kept (D16). */
export const PLATFORM_RETENTION_DAYS = 400;

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    quotas: { mau: 1_000, clients: 3, domains: 1, agents: 100, webhooks: 2 },
    auditRetentionDays: 30,
  },
  {
    id: "pro",
    name: "Pro",
    quotas: {
      mau: 10_000,
      clients: 20,
      domains: 5,
      agents: 1_000,
      webhooks: 10,
    },
    auditRetentionDays: 90,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    quotas: {
      mau: null,
      clients: null,
      domains: null,
      agents: null,
      webhooks: 50,
    },
    auditRetentionDays: 365,
  },
];

export const isPlanId = (value: string): value is PlanId =>
  (PLAN_IDS as readonly string[]).includes(value);

export const planOf = (id: PlanId): Plan =>
  PLANS.find((plan) => plan.id === id) as Plan;

/** A tenant's overrides as quotas: `null` where the plan's quota applies. */
export const overridesOf = (overrides: QuotaOverrides): Quotas => ({
  mau: overrides.mau ?? null,
  clients: overrides.clients ?? null,
  domains: overrides.domains ?? null,
  agents: overrides.agents ?? null,
  webhooks: overrides.webhooks ?? null,
});

/** What applies to a tenant: its plan's quotas with its overrides on top. */
export function effectiveQuotas(tenant: {
  plan: PlanId;
  quotaOverrides: QuotaOverrides;
}): Quotas {
  const { quotas } = planOf(tenant.plan);
  return {
    mau: tenant.quotaOverrides.mau ?? quotas.mau,
    clients: tenant.quotaOverrides.clients ?? quotas.clients,
    domains: tenant.quotaOverrides.domains ?? quotas.domains,
    agents: tenant.quotaOverrides.agents ?? quotas.agents,
    webhooks: tenant.quotaOverrides.webhooks ?? quotas.webhooks,
  };
}
