import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const invitations: Resolvers = {
  Query: {
    invitationPreview: (_, { code }, ctx) =>
      services().invitations.preview(ctx, code),
  },
  Mutation: {
    acceptInvitation: (_, { code }, ctx) =>
      services().invitations.accept(ctx, code),
  },
};
