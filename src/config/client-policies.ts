import { ObjectId } from "mongodb";
import { ClientPoliciesService } from "@/modules/client-policies/client-policies.service";
import type { ExchangeRulesFor } from "@/oauth/ports";
import { mongo } from "./db";

/** The real per-client rules store. The collection is tenant-owned: only this wiring and its module reach it. */
export const clientPoliciesService = new ClientPoliciesService(
  mongo.db.clientPolicies,
);

/** The real `ExchangeRulesFor`: the token exchange rules of a tenant's clients. */
export const exchangeRulesFor: ExchangeRulesFor = (tenant) => (clientId) =>
  clientPoliciesService.tokenExchange(new ObjectId(tenant.tenantId), clientId);
