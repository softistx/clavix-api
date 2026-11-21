import { z } from "zod";
import { production } from "./shared";

// Webhook endpoints, the durable delivery queue and the consent-ready tenants.
export const webhooksEnv = {
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
  // The tenants whose clients may list authorization detail types (RFC 9396) on
  // a flow with a consent page (code or device): slugs separated by commas, or `*` for every tenant. Janus
  // approves every detail it validated and the consent pages that show them are
  // not built yet, so until they are no code or device client may opt in.
  // Temporary, removed with the consent page (M3b V4). Default: none.
  CLAVIX_RAR_CONSENT_READY: z.string().default(""),
};
