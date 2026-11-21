import type { SocialProvider } from "@softistx/janus";
import { github, google, microsoft } from "@softistx/janus-social";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { enabledSocial, type SocialProviderId } from "./sign-in-methods.schema";
import { type SecretBox, secretContext } from "./sign-in-methods.secrets";

/**
 * Where a provider sends the visitor back: the hosted page of the tenant's
 * issuer host (`/sign-in/social/:provider/callback`, clavix-ui). This is the
 * redirect URI the tenant registers in its own app.
 */
export const callbackUrlOf = (issuer: string, provider: string) =>
  `${issuer}/sign-in/social/${encodeURIComponent(provider)}/callback`;

const PRESETS = { google, github, microsoft } as const;

/**
 * The tenant's enabled social apps as janus providers, secrets opened with the
 * secret box. One that cannot be built (an unopenable secret, a redirect URI
 * the preset refuses) is left out and reported by name only, never failing
 * the tenant's other sign-in methods.
 */
export function socialProvidersOf(
  tenant: ResolvedTenant,
  box: SecretBox,
  onSkipped: (provider: SocialProviderId, reason: string) => void,
): Record<string, SocialProvider> {
  const providers: Record<string, SocialProvider> = {};
  for (const entry of enabledSocial(tenant.signIn)) {
    try {
      providers[entry.provider] = PRESETS[entry.provider]({
        clientId: entry.clientId,
        clientSecret: box.open(
          entry.secret,
          secretContext(tenant.tenantId, entry.provider),
        ),
        redirectUri: callbackUrlOf(tenant.issuer, entry.provider),
      });
    } catch (error) {
      // The error's name only: a message could quote the configuration.
      onSkipped(
        entry.provider,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
  return providers;
}
