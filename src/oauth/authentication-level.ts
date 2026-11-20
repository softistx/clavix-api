// What a session proved, as the `acr` and `amr` an approval carries (D9), and
// whether it meets what the tenant's policy (D7) and the client's request
// (`acr_values`, `max_age`, `prompt=login`: D10) ask. Pure: no store, no clock
// of its own, so the rules read and test in one place.

/** The `acr` values Clavix issues and publishes in `acr_values_supported` (D9), weakest first. */
export const ACR = {
  first: "urn:clavix:acr:1fa",
  mfa: "urn:clavix:acr:mfa",
  phishingResistant: "phr",
} as const;

export const SUPPORTED_ACR: readonly string[] = [
  ACR.first,
  ACR.mfa,
  ACR.phishingResistant,
];

const RANK: Readonly<Record<string, number>> = {
  [ACR.first]: 0,
  [ACR.mfa]: 1,
  [ACR.phishingResistant]: 2,
};

const ACR_OF_RANK = [ACR.first, ACR.mfa, ACR.phishingResistant] as const;

/**
 * How long a proof still counts for `max_age=0` and `prompt=login`: the pending
 * request carries no creation time, so "proved since the request began" is
 * read as "proved within this grace" (janus-social does the same for a
 * `prompt=login` round trip).
 */
export const FRESH_GRACE_SECONDS = 60;

/** The `acr` a session's methods reach: `phr` for a user-verified passkey, `mfa` for two factors, else `1fa`. */
export function acrOf(amr: readonly string[]): string {
  if (amr.includes("hwk") && amr.includes("user")) return ACR.phishingResistant;
  if (amr.includes("mfa")) return ACR.mfa;
  return ACR.first;
}

/**
 * The `amr` an approval carries: RFC 8176 values janus recorded, with a lone
 * `otp` (the e-mailed code or link of a first factor) named `email` (D9); `otp`
 * stays where `mfa` says it was an authenticator code. `fed` stays as it is.
 */
export function amrOut(amr: readonly string[]): string[] {
  const second = amr.includes("mfa");
  return amr.map((value) => (value === "otp" && !second ? "email" : value));
}

/** What a request can still be missing. */
export type Gap = "SECOND_FACTOR" | "FRESH_PROOF" | "ENROLMENT";

export interface Demands {
  /** `acr_values` of the request (essential: D10). */
  acrValues: readonly string[];
  /** `max_age` of the request in seconds, `null` for none. */
  maxAge: number | null;
  /** `prompt` of the request; `login` counts as `max_age=0`. */
  prompt: readonly string[];
  /** The tenant's mode (D7): `required` asks a multi-factor session whatever the request says. */
  mode: "passkeySufficient" | "required";
}

/** What the user could do to reach a second factor now. */
export interface Factors {
  /** The user holds a registered passkey or an active authenticator app. */
  available: boolean;
  /** The user holds a registered passkey: what `phr` needs, which an app code never gives. Defaults to `available`. */
  passkey?: boolean;
}

export interface Assessment {
  /** The `acr` to put on the approval: the requested value met, else the best reached. */
  acr: string;
  /** The `acr` the session has reached, whatever was asked. */
  reached: string;
  /** The `amr` to put on the approval. */
  amr: string[];
  /** The `acr` the policy and the request ask, `null` when they ask none. */
  required: string | null;
  /** The effective `max_age` in seconds (`prompt=login` is 0), `null` for none. */
  maxAge: number | null;
  met: boolean;
  missing: Gap[];
}

/**
 * Whether `session` meets `demands` at `now`, and what is missing when it does
 * not. `acr_values` are essential, any one supported value met satisfies them,
 * and a request that names none Clavix supports can never be met (`met: false`,
 * nothing missing: the user can do nothing about it).
 */
export function assess(
  session: { amr: readonly string[]; authenticatedAt: Date },
  demands: Demands,
  factors: Factors,
  now: Date,
): Assessment {
  const reached = acrOf(session.amr);
  const reachedRank = RANK[reached] ?? 0;

  const supported = demands.acrValues.filter((value) => value in RANK);
  const unsupportedOnly =
    demands.acrValues.length > 0 && supported.length === 0;
  // The easiest of the requested values; the policy's floor is `mfa`.
  const requestedRank =
    supported.length === 0
      ? 0
      : Math.min(...supported.map((value) => RANK[value] ?? 0));
  const floorRank = demands.mode === "required" ? (RANK[ACR.mfa] ?? 1) : 0;
  const requiredRank = Math.max(requestedRank, floorRank);
  const required =
    supported.length > 0 || floorRank > 0
      ? (ACR_OF_RANK[requiredRank] ?? null)
      : null;

  const maxAge = demands.prompt.includes("login") ? 0 : demands.maxAge;
  const age = Math.max(
    0,
    Math.floor((now.getTime() - session.authenticatedAt.getTime()) / 1000),
  );
  const fresh =
    maxAge === null || age <= (maxAge === 0 ? FRESH_GRACE_SECONDS : maxAge);

  const missing: Gap[] = [];
  const levelMet = !unsupportedOnly && reachedRank >= requiredRank;
  if (!levelMet && !unsupportedOnly) {
    // `phr` needs a passkey: without one, the user enrols whatever else they hold.
    const possible =
      requiredRank >= (RANK[ACR.phishingResistant] ?? 2)
        ? (factors.passkey ?? factors.available)
        : factors.available;
    missing.push(possible ? "SECOND_FACTOR" : "ENROLMENT");
  }
  if (!fresh) missing.push("FRESH_PROOF");

  // The value the approval states: a requested one the session meets, else the
  // best it reached (so the client sees what it really got).
  const met = levelMet && fresh;
  const metRequested = supported
    .filter((value) => reachedRank >= (RANK[value] ?? 0))
    .sort((a, b) => (RANK[a] ?? 0) - (RANK[b] ?? 0))[0];
  return {
    acr: metRequested ?? reached,
    reached,
    amr: amrOut(session.amr),
    required,
    maxAge,
    met,
    missing,
  };
}
