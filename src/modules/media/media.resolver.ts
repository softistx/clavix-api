import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const media: Resolvers = {
  Mutation: {
    removeMyPicture: (_, __, ctx) => services().avatars.removeOwn(ctx),
  },
};
