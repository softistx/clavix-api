import { z } from "zod";
import { isProduction } from "./shared";

// Webhook endpoints, the durable delivery queue and the consent-ready tenants.
export const webhooksEnv = () => {
  const production = isProduction();
  return {
    // Webhook endpoints may point at private or loopback addresses (D21), for a
    // local receiver in development; refused in production, where only public
    // addresses are reached.
    CLAVIX_WEBHOOKS_ALLOW_PRIVATE: z
      .enum(production ? ["false"] : ["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // The durable webhook queue's caps (G2-03), counted per tenant (the queue's
    // group) across every process: requests in flight at once, and deliveries
    // held. A tenant's flood waits or is refused alone; the other tenants'
    // endpoints keep being claimed. A delivery refused past the second is not
    // queued and not retried.
    CLAVIX_WEBHOOKS_MAX_IN_FLIGHT: z.coerce.number().int().min(1).default(4),
    CLAVIX_WEBHOOKS_MAX_PENDING: z.coerce.number().int().min(1).default(5000),
  };
};
