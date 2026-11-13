import { ObjectId } from "mongodb";
import { partitionOf } from "@/modules/tenants/identity";
import { UsageService } from "@/modules/usage/usage.service";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";
import { redis } from "./redis";

/**
 * The real usage meters. The `usageCounters` collection is tenant-owned: only
 * this wiring and its module reach it. Clients are counted in the tenant's
 * partition of the janus OAuth collections; custom domains do not exist yet
 * (A4), so they count 0.
 * Temporary, until the domains store (clavix-api#11) provides a count.
 */
export const usageService = new UsageService(
  mongo.db.usageCounters,
  {
    clients: (tenantId) =>
      oauthDb.collection("oauthPartitionedClients").countDocuments({
        partition: partitionOf(new ObjectId(tenantId)),
        source: "registered",
      }),
    domains: async () => 0,
  },
  redis?.mau,
);
