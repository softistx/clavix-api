import type { SocialProviderId } from "./sign-in-methods.schema";

/** The change a tenant makes to one social app. A value left out keeps the stored one. */
export interface SocialInput {
  provider: SocialProviderId;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  enabled?: boolean | undefined;
}

/** A social change's strings once checked: trimmed, 1 to 512 characters; `undefined` when left out. */
export interface CheckedSocial {
  clientId: string | undefined;
  clientSecret: string | undefined;
}
