import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const auth: Resolvers = {
  Query: {
    currentUser: (_, __, ctx) => services().auth.currentUser(ctx),
  },
  Mutation: {
    requestSignInCode: (_, { email }, ctx) =>
      services().auth.requestSignInCode(ctx, email),
    verifySignInCode: (_, { challenge, code }, ctx) =>
      services().auth.verifySignInCode(ctx, challenge, code),
    requestMagicLink: (_, { email }, ctx) =>
      services().auth.requestMagicLink(ctx, email),
    confirmMagicLink: (_, { token }, ctx) =>
      services().auth.confirmMagicLink(ctx, token),
    requestEmailVerification: (_, __, ctx) =>
      services().auth.requestEmailVerification(ctx),
    confirmEmailVerification: (_, { token }, ctx) =>
      services().auth.confirmEmailVerification(ctx, token),
    signOut: (_, __, ctx) => services().auth.signOut(ctx),
  },
};
