import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { auth } from "./auth/auth.resolver";
import { branding } from "./branding/branding.resolver";
import { connections } from "./connections/connections.resolver";
import { health } from "./health/health.resolver";
import { invitations } from "./invitations/invitations.resolver";
import { media } from "./media/media.resolver";
import { mfa } from "./mfa/mfa.resolver";
import { passkeys } from "./passkeys/passkeys.resolver";
import { signInMethods } from "./sign-in-methods/sign-in-methods.resolver";

// One entry per module; each module exports its `Resolvers`.
export const resolvers: Resolvers = mergeResolvers([
  health,
  auth,
  invitations,
  passkeys,
  branding,
  mfa,
  signInMethods,
  connections,
  media,
]);
