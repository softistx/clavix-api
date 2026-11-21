import type { Resolvers } from "@/generated/graphql/resolvers";
import { services } from "@/modules/services";

export const mfa: Resolvers = {
  Query: {
    secondFactor: (_, __, ctx) => services().mfa.secondFactor(ctx),
    sessionConfirmedUntil: (_, __, ctx) =>
      services().mfa.sessionConfirmedUntil(ctx),
  },
  Mutation: {
    confirmSecondFactor: (_, { challenge, code }, ctx) =>
      services().mfa.confirmSecondFactor(ctx, challenge, code),
    recoverSecondFactor: (_, { challenge, recoveryCode }, ctx) =>
      services().mfa.recoverSecondFactor(ctx, challenge, recoveryCode),
    confirmSecondFactorWithPasskey: (_, { challenge, assertion }, ctx) =>
      services().mfa.confirmSecondFactorWithPasskey(ctx, challenge, assertion),
    requestSecondFactorPasskeyOptions: (_, { challenge }, ctx) =>
      services().mfa.passkeyOptions(ctx, challenge),
    enrollSecondFactor: (_, __, ctx) => services().mfa.enrollSecondFactor(ctx),
    activateSecondFactor: (_, { code }, ctx) =>
      services().mfa.activateSecondFactor(ctx, code),
    regenerateRecoveryCodes: (_, { code }, ctx) =>
      services().mfa.regenerateRecoveryCodes(ctx, code),
    disableSecondFactor: (_, { code }, ctx) =>
      services().mfa.disableSecondFactor(ctx, code),
    requestStepUp: (_, __, ctx) => services().mfa.requestStepUp(ctx),
    confirmStepUp: (_, { challenge, code }, ctx) =>
      services().mfa.confirmStepUp(ctx, challenge, code),
    requestPasskeyStepUp: (_, __, ctx) =>
      services().mfa.requestPasskeyStepUp(ctx),
    confirmPasskeyStepUp: (_, { challenge, response }, ctx) =>
      services().mfa.confirmPasskeyStepUp(ctx, challenge, response),
  },
};
