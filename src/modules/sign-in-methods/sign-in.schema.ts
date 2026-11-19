import { z } from "zod";

/** The sign-in methods of a policy, in the order every API lists them. */
export const METHOD_TYPES = [
  "passkey",
  "emailCode",
  "magicLink",
  "password",
] as const;
export type MethodType = (typeof METHOD_TYPES)[number];

/** The social providers a tenant can bring its own app for (`@softistx/janus-social` presets). */
export const SOCIAL_PROVIDERS = ["google", "github", "microsoft"] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number];

export const SOCIAL_LABELS: Record<SocialProviderId, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
};

/**
 * What a tenant offers until it says otherwise: passkey and e-mail code, the
 * way every tenant signed in before the policy; magic link and password are
 * off until the tenant turns them on.
 */
const DEFAULTS: Record<MethodType, boolean> = {
  passkey: true,
  emailCode: true,
  magicLink: false,
  password: false,
};

/**
 * The methods Clavix can offer today. Password is not one yet: the tenant user
 * type has no password and no hosted page signs in by it, so it stays off.
 */
const AVAILABLE: Record<MethodType, boolean> = {
  passkey: true,
  emailCode: true,
  magicLink: true,
  password: false,
};

export const isAvailable = (type: MethodType): boolean => AVAILABLE[type];

const methodEntrySchema = z.object({
  type: z.enum(METHOD_TYPES),
  enabled: z.boolean(),
});
export type MethodEntry = z.infer<typeof methodEntrySchema>;

const defaultMethods = (): MethodEntry[] =>
  METHOD_TYPES.map((type) => ({ type, enabled: DEFAULTS[type] }));

/**
 * A secret at rest (`secrets.ts`): `v` the envelope version, `kid` the master
 * key it was sealed under (so a master-key rotation finds what to re-wrap),
 * `iv` and `ct` (ciphertext and tag) in base64url.
 */
export const sealedSecretSchema = z.object({
  v: z.literal(1),
  kid: z.string(),
  iv: z.string(),
  ct: z.string(),
});
export type SealedSecret = z.infer<typeof sealedSecretSchema>;

/** One social app of a tenant (ADR-0035). `secret` is never returned by an API or logged. */
const socialEntrySchema = z.object({
  provider: z.enum(SOCIAL_PROVIDERS),
  clientId: z.string(),
  secret: sealedSecretSchema,
  enabled: z.boolean(),
});
export type SocialEntry = z.infer<typeof socialEntrySchema>;

/** D7: `passkeySufficient` asks no second factor at sign-in; `required` asks a multi-factor session at every approval (enforced at consent, M2). */
export const MFA_MODES = ["passkeySufficient", "required"] as const;
export type MfaMode = (typeof MFA_MODES)[number];

/**
 * The tenant's multi-factor policy (D7, D8). `totp` says whether its users may
 * enrol an authenticator app (off until the tenant turns it on: janus asks for
 * the code of every user who holds an active factor anyway, so turning it off
 * only closes the enrolment).
 */
export const mfaPolicySchema = z.object({
  mode: z.enum(MFA_MODES).default("passkeySufficient"),
  totp: z.boolean().default(false),
});
export type MfaPolicy = z.infer<typeof mfaPolicySchema>;

const defaultMfa = (): MfaPolicy => ({
  mode: "passkeySufficient",
  totp: false,
});

/**
 * A tenant's sign-in policy (slice A5): the tenant document's `signIn` field
 * and `ResolvedTenant.signIn`. `methods` is a list of entries, one per type at
 * most (a type with no entry reads its default); a later `mfa` block sits
 * beside `methods` and `social` (`mfa`, M4; a tenant cached before it reads the
 * defaults). A tenant stored before the policy existed reads the defaults.
 */
export const signInPolicySchema = z
  .object({
    methods: z.array(methodEntrySchema).default(defaultMethods),
    social: z.array(socialEntrySchema).default([]),
    mfa: mfaPolicySchema.default(defaultMfa),
  })
  .default(() => ({
    methods: defaultMethods(),
    social: [],
    mfa: defaultMfa(),
  }));
export type SignInPolicy = z.infer<typeof signInPolicySchema>;

/** Whether the policy turns `type` on. An unavailable method is never on. */
export function isEnabled(policy: SignInPolicy, type: MethodType): boolean {
  const entry = policy.methods.find((method) => method.type === type);
  return isAvailable(type) && (entry?.enabled ?? DEFAULTS[type]);
}

/** Every method type with its state, in `METHOD_TYPES` order. */
export const methodsOf = (policy: SignInPolicy): MethodEntry[] =>
  METHOD_TYPES.map((type) => ({ type, enabled: isEnabled(policy, type) }));

/** The social apps that sign users in. */
export const enabledSocial = (policy: SignInPolicy): SocialEntry[] =>
  policy.social.filter((entry) => entry.enabled);

/**
 * The enabled providers whose secret was sealed under a key of the keyring
 * (`opens`), so they can be opened: what the hosted page offers. One sealed under another
 * master key is configured but unusable until its secret is entered again.
 */
export const offeredSocial = (
  policy: SignInPolicy,
  opens: (kid: string) => boolean,
) => enabledSocial(policy).filter((entry) => opens(entry.secret.kid));

/** Whether a user could still sign in: a method or a social provider is on. */
export const hasSignInMethod = (policy: SignInPolicy): boolean =>
  methodsOf(policy).some((method) => method.enabled) ||
  enabledSocial(policy).length > 0;
