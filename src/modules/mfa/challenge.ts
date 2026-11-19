import {
  type ChallengeIn,
  type ChallengeOut,
  secondFactorChallengeOut,
} from "@softistx/janus-graphql";

/** The `SecondFactorChallenge` of an already shaped challenge, with `returnTo` for a social flow. */
export const challengeAnswer = (
  out: ChallengeOut,
  returnTo: string | null = null,
) => ({
  __typename: "SecondFactorChallenge" as const,
  challenge: out.challenge,
  expiresAt: out.expiresAt,
  methods: [...out.methods],
  passkeyOptions: out.passkeyOptions,
  returnTo,
});

/**
 * The challenge a core sign-in (code, link) answers for a user who holds a TOTP
 * factor, in janus's shape (`secondFactorChallengeOut`). Single use, so the
 * caller marks the response `no-store`.
 */
export const challengeOf = (done: ChallengeIn, request: Request) =>
  challengeAnswer(secondFactorChallengeOut(done, request));
