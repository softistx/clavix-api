import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { auth } from "./auth";
import { branding } from "./branding";
import { connections } from "./connections/connections.resolver";
import { health } from "./health";
import { invitations } from "./invitations";
import { mfa } from "./mfa";
import { passkeys } from "./passkeys";
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
]);
