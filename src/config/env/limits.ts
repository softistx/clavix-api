import { z } from "zod";

// Rate limits, per client address, tenant, user or caller (Redis only unless said).
export const limitsEnv = {
  // Sign-in code requests (`requestSignInCode`), on top of janus's 5 per address
  // per 10 min. Per client address and tenant, and per tenant. They need
  // Redis (REDIS_URL): without it there is no such limit.
  CLAVIX_CODE_IP_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_CODE_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_CODE_TENANT_LIMIT: z.coerce.number().int().min(1).default(200),
  CLAVIX_CODE_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Passkey sign-in options (`passkeySignInOptions`, anonymous, one token per
  // call), per client address and tenant, and per tenant. Redis only, as above.
  CLAVIX_PASSKEY_IP_LIMIT: z.coerce.number().int().min(1).default(60),
  CLAVIX_PASSKEY_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_PASSKEY_TENANT_LIMIT: z.coerce.number().int().min(1).default(600),
  CLAVIX_PASSKEY_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Verification mails (`requestEmailVerification`, signed in): per user, then
  // per client address and tenant, and per tenant, on top of janus's 5 per
  // address per 10 min. Redis only, as above.
  CLAVIX_VERIFY_USER_LIMIT: z.coerce.number().int().min(1).default(10),
  CLAVIX_VERIFY_USER_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  CLAVIX_VERIFY_IP_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_VERIFY_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_VERIFY_TENANT_LIMIT: z.coerce.number().int().min(1).default(200),
  CLAVIX_VERIFY_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Device code lookups (the verification page's `oauthDeviceRequest`,
  // `approveOAuthDeviceRequest` and `denyOAuthDeviceRequest`, signed in): per
  // user, then per client address and tenant, and per tenant. Every lookup
  // counts, hit or miss; a person needs two per approval. Redis only, as above.
  CLAVIX_DEVICE_USER_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_DEVICE_USER_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(600),
  CLAVIX_DEVICE_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  CLAVIX_DEVICE_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_DEVICE_TENANT_LIMIT: z.coerce.number().int().min(1).default(300),
  CLAVIX_DEVICE_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Picture uploads (`PUT /media/avatar`, signed in): per user, then per
  // client address and tenant, and per tenant. Redis only, as above.
  CLAVIX_AVATAR_USER_LIMIT: z.coerce.number().int().min(1).default(10),
  CLAVIX_AVATAR_USER_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  CLAVIX_AVATAR_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  CLAVIX_AVATAR_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  CLAVIX_AVATAR_TENANT_LIMIT: z.coerce.number().int().min(1).default(1000),
  CLAVIX_AVATAR_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Dynamic client registration (`POST /register`, agents): per client address
  // and tenant, and per tenant. Every call stores a client for anyone who asks,
  // so the address budget is small (janus: 5 an hour open, 20 with a list).
  // Redis only, as above.
  CLAVIX_REGISTER_IP_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_REGISTER_IP_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  CLAVIX_REGISTER_TENANT_LIMIT: z.coerce.number().int().min(1).default(500),
  CLAVIX_REGISTER_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Single sign-on starts that send no mail (`hostedHomeRealm`, and
  // `socialSignInStart`, each with its own buckets): per client address and
  // tenant, and per tenant, apart from the sign-in code budget above.
  // Redis only, as above.
  CLAVIX_SSO_IP_LIMIT: z.coerce.number().int().min(1).default(60),
  CLAVIX_SSO_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(600),
  CLAVIX_SSO_TENANT_LIMIT: z.coerce.number().int().min(1).default(2000),
  CLAVIX_SSO_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Console `sendTestWebhook`: per endpoint and per tenant, over one window
  // (a test event holds a slot of the shared delivery queue). Redis only.
  CLAVIX_WEBHOOK_TEST_ENDPOINT_LIMIT: z.coerce.number().int().min(1).default(5),
  CLAVIX_WEBHOOK_TEST_TENANT_LIMIT: z.coerce.number().int().min(1).default(20),
  CLAVIX_WEBHOOK_TEST_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(60),
  // Console `inviteUser` / `inviteAdmin` (each sends a mail): per caller and
  // mutation (every aliased selection of one POST counts), and per tenant,
  // both mutations together. Redis only.
  CLAVIX_INVITE_CALLER_LIMIT: z.coerce.number().int().min(1).default(60),
  CLAVIX_INVITE_CALLER_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  CLAVIX_INVITE_TENANT_LIMIT: z.coerce.number().int().min(1).default(200),
  CLAVIX_INVITE_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Pending invitations one tenant (or the admin list of one tenant) may
  // hold; a new address past it is refused (`PENDING_INVITATIONS_LIMIT`).
  // Read from the store, so it needs no Redis.
  CLAVIX_INVITE_PENDING_LIMIT: z.coerce.number().int().min(1).default(500),
  // Audit exports (GET /console/audit/export): starts per tenant, Redis only.
  CLAVIX_EXPORT_TENANT_LIMIT: z.coerce.number().int().min(1).default(10),
  CLAVIX_EXPORT_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3600),
  // Client ID Metadata Document fetches (`/authorize`, `/par` with a URL
  // `client_id`, agents): each is an outbound request an anonymous caller
  // chose. Per client address and tenant, and per tenant; janus advises about
  // 30 a minute per address. Redis only, as above.
  CLAVIX_METADATA_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  CLAVIX_METADATA_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  CLAVIX_METADATA_TENANT_LIMIT: z.coerce.number().int().min(1).default(300),
  CLAVIX_METADATA_TENANT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(60),
  // The ports a Client ID Metadata Document may be served on (janus-oauth
  // `allowPorts`): the document's URL names the port the server connects to.
  // Comma-separated; 443 by default, add a port only for a client that needs it.
  CLAVIX_METADATA_PORTS: z
    .string()
    .default("443")
    .transform((value) => {
      const ports = value
        .split(",")
        .map((port) => Number(port.trim()))
        .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
      return ports.length === 0 ? [443] : ports;
    }),
};
