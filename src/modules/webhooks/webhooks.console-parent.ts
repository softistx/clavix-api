/**
 * What a `WebhookEndpoint` resolver starts from: the endpoint's fields and its
 * tenant's id, which `deliveries` reads the attempts through. `tenantId` is not
 * a field of the type.
 */
export interface WebhookEndpointParent {
  tenantId: string;
  id: string;
  url: string;
  description: string;
  types: string[];
  enabled: boolean;
  disabledReason: "GIVEN_UP" | "MANUAL" | null;
  consecutiveGiveUps: number;
  secrets: { createdAt: Date; expiresAt: Date | null }[];
  createdAt: Date;
  updatedAt: Date;
}
