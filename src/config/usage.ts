import { ObjectId } from "mongodb";
import { partitionOf } from "@/modules/tenants/identity";
import { UsageService } from "@/modules/usage/usage.service";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { redis } from "./redis";
import { domainStore } from "./tenancy";

/**
 * The real usage meters. The `usageCounters` collection is tenant-owned: only
 * this wiring and its module reach it. Clients are counted in the tenant's
 * partition of the janus OAuth collections; custom domains are the tenant's
 * claims in the domain store, pending ones included (a hard quota).
 */
export const usageService = new UsageService(
  mongo.db.usageCounters,
  {
    clients: (tenantId) =>
      oauthDb.collection("oauthPartitionedClients").countDocuments({
        partition: partitionOf(new ObjectId(tenantId)),
        source: "registered",
      }),
    domains: (tenantId) => domainStore.count(new ObjectId(tenantId)),
  },
  redis?.mau,
);
