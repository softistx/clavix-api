/** How long a session counts as freshly confirmed for the writes of the factor. */
export const FRESH_WITHIN = "10m" as const;

/** `FRESH_WITHIN` in milliseconds: the window `confirmedUntil` answers. */
export const FRESH_WITHIN_MS = 10 * 60 * 1000;

/** A date from the ISO string janus-graphql answers. */
export const iso = (value: string) => new Date(value);

/** The name of a janus user, `null` when it has none or a blank one. */
export const nameOf = (user: object): string | null => {
  const name = (user as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : null;
};

/** The proof a passkey step-up stamps: confirmed now, until the freshness window ends. */
export const confirmed = (at: Date) => ({
  confirmedAt: at,
  confirmedUntil: new Date(at.getTime() + FRESH_WITHIN_MS),
});

/** The `SecondFactorSignedIn.user` of a janus user. */
export const signedInUserOf = (user: {
  id: string;
  email: string;
  name?: string | undefined;
  emailVerified: boolean;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name ?? null,
  emailVerified: user.emailVerified,
});
