import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const account: Resolvers = {
  CurrentUser: {
    profile: (user, _, ctx) => services().account.profile(ctx, user.id),
    lockedFields: (_, __, ctx) => services().account.lockedFields(ctx),
    attributes: (user, _, ctx) => services().account.attributes(ctx, user.id),
  },
  Mutation: {
    updateMyProfile: (_, { input }, ctx) =>
      services().account.updateMyProfile(ctx, input),
    setMyAttributeValues: (_, { values }, ctx) =>
      services().account.setMyAttributeValues(ctx, values),
    requestEmailChange: (_, { email }, ctx) =>
      services().account.requestEmailChange(ctx, email),
    confirmEmailChange: (_, { token }, ctx) =>
      services().account.confirmEmailChange(ctx, token),
  },
};
