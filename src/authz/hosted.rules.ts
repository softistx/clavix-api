import type { GraphqlRules } from "@/generated/limix";

import { open, signedIn } from "./rules.helpers";

/**
 * The hosted API's (`/graphql`) access rules, one entry per root field.
 *
 * Coarse on purpose: a field is `authenticated` when it only ever answers a
 * signed-in session, `public` otherwise. A `public` field is not unguarded:
 * the sign-in, recovery and OAuth fields prove who calls with a credential
 * (a code, a token, a pending challenge) or a throttle in the resolver, and the
 * session-bound ones check it there. Those checks stay.
 */
export const hostedRules = {
  Query: {
    connectedApps: signedIn,
    currentUser: open,
    health: open,
    hostedHomeRealm: open,
    hostedSignInMethods: open,
    invitationPreview: open,
    myPasskeys: signedIn,
    oauthDeviceRequest: signedIn,
    oauthRequest: signedIn,
    secondFactor: signedIn,
    sessionConfirmedUntil: open,
    tenantBranding: open,
  },
  Mutation: {
    acceptInvitation: open,
    activateSecondFactor: signedIn,
    approveOAuthDeviceRequest: signedIn,
    approveOAuthRequest: signedIn,
    confirmEmailChange: signedIn,
    confirmEmailVerification: signedIn,
    confirmMagicLink: open,
    confirmPasskeyStepUp: signedIn,
    confirmSecondFactor: open,
    confirmSecondFactorWithPasskey: open,
    confirmStepUp: signedIn,
    denyOAuthDeviceRequest: signedIn,
    denyOAuthRequest: signedIn,
    disableSecondFactor: signedIn,
    enrollSecondFactor: signedIn,
    passkeyRegistrationOptions: signedIn,
    passkeySignInOptions: open,
    recoverSecondFactor: open,
    regenerateRecoveryCodes: signedIn,
    registerPasskey: signedIn,
    removeMyPicture: signedIn,
    removePasskey: signedIn,
    requestEmailChange: signedIn,
    requestEmailVerification: signedIn,
    requestMagicLink: open,
    requestPasskeyStepUp: signedIn,
    requestSecondFactorPasskeyOptions: open,
    requestSignInCode: open,
    requestStepUp: signedIn,
    revokeConnectedApp: signedIn,
    setMyAttributeValues: signedIn,
    signInWithPasskey: open,
    signOut: open,
    socialSignInComplete: open,
    socialSignInStart: open,
    updateMyProfile: signedIn,
    verifySignInCode: open,
  },
} satisfies GraphqlRules;
