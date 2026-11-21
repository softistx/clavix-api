import { ObjectId } from "mongodb";
import type { EndpointSecret } from "@/modules/webhooks/webhooks.model";
import type { WebhookEndpointDoc } from "@/modules/webhooks/webhooks.types";

/** A sealed secret under the master key `kid` (the bytes are placeholders, never opened). */
export const sealedUnder = (
  kid: string,
  ct = "ct",
): EndpointSecret["sealed"] => ({
  v: 1,
  kid,
  iv: "iv",
  ct,
});

/** A complete stored endpoint: every field filled, the `patch` written over it. */
export const endpointDoc = (
  patch: Partial<WebhookEndpointDoc> = {},
): WebhookEndpointDoc => {
  const _id = patch._id ?? new ObjectId();
  return {
    id: _id.toHexString(),
    _id,
    tenantId: new ObjectId(),
    url: "https://hooks.example.com/in",
    description: "",
    types: [],
    enabled: true,
    secrets: [],
    consecutiveGiveUps: 0,
    disabledReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  };
};
