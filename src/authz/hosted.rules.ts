import type { GraphqlRules } from "@/generated/limix";

const signedIn = { authenticated: true } as const;
const open = { public: true } as const;

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
    oauthDeviceRequest: open,
    oauthRequest: open,
    secondFactor: open,
    sessionConfirmedUntil: open,
    tenantBranding: open,
  },
  Mutation: {
    acceptInvitation: open,
    activateSecondFactor: open,
    approveOAuthDeviceRequest: open,
    approveOAuthRequest: open,
    confirmEmailChange: open,
    confirmEmailVerification: open,
    confirmMagicLink: open,
    confirmPasskeyStepUp: open,
    confirmSecondFactor: open,
    confirmSecondFactorWithPasskey: open,
    confirmStepUp: open,
    denyOAuthDeviceRequest: open,
    denyOAuthRequest: open,
    disableSecondFactor: signedIn,
    enrollSecondFactor: open,
    passkeyRegistrationOptions: signedIn,
    passkeySignInOptions: open,
    recoverSecondFactor: open,
    regenerateRecoveryCodes: signedIn,
    registerPasskey: signedIn,
    removeMyPicture: signedIn,
    removePasskey: signedIn,
    requestEmailChange: signedIn,
    requestEmailVerification: open,
    requestMagicLink: open,
    requestPasskeyStepUp: open,
    requestSecondFactorPasskeyOptions: open,
    requestSignInCode: open,
    requestStepUp: open,
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
