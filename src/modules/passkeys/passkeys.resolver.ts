import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const passkeys: Resolvers = {
  Query: {
    myPasskeys: (_, __, ctx) => services().passkeys.list(ctx),
  },
  Mutation: {
    passkeySignInOptions: (_, __, ctx) =>
      services().passkeys.signInOptions(ctx),
    signInWithPasskey: (_, { challenge, response }, ctx) =>
      services().passkeys.signIn(ctx, challenge, response),
    passkeyRegistrationOptions: (_, __, ctx) =>
      services().passkeys.registrationOptions(ctx),
    registerPasskey: (_, { challenge, response, name }, ctx) =>
      services().passkeys.register(ctx, challenge, response, name),
    removePasskey: (_, { id }, ctx) => services().passkeys.remove(ctx, id),
  },
};
