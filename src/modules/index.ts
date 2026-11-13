import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { auth } from "./auth";
import { health } from "./health";
import { invitations } from "./invitations";
import { passkeys } from "./passkeys";

// One entry per module; each module exports its `Resolvers`.
export const resolvers: Resolvers = mergeResolvers([
  health,
  auth,
  invitations,
  passkeys,
]);
