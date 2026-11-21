import type { BoundUniqueCounter } from "@softistx/redis";
import type { monthlyActiveUsers } from "./usage.counter";

export type MauCounter = BoundUniqueCounter<
  Parameters<(typeof monthlyActiveUsers)["key"]>[0]
>;

/** Where the counts that are not Redis's come from (the clients and domains stores). */
export interface UsageSources {
  /** The tenant's registered OAuth clients now. */
  clients(tenantId: string): Promise<number>;
  /** The tenant's custom domains now. */
  domains(tenantId: string): Promise<number>;
  /** The tenant's agents now (dynamically registered and metadata-document clients). */
  agents(tenantId: string): Promise<number>;
  /** The tenant's webhook endpoints now. */
  webhooks(tenantId: string): Promise<number>;
  /** The tenant's enterprise OIDC connections now. */
  connections(tenantId: string): Promise<number>;
}

export interface UsageMeter {
  used: number;
  quota: number | null;
  exceeded: boolean;
}

export interface UsageReport {
  tenantId: string;
  month: string;
  mau: UsageMeter;
  clients: UsageMeter;
  domains: UsageMeter;
  agents: UsageMeter;
  webhooks: UsageMeter;
  connections: UsageMeter;
}
