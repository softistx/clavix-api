import { domainToASCII } from "node:url";
import { unique } from "@/shared/values";
import type { DomainDoc } from "./domains.model";

/** Why a claim did not verify: no record, another value, or DNS could not answer. */
export type CheckFailure = "NO_RECORD" | "MISMATCH" | "LOOKUP_FAILED";

/** Seconds a claim must wait between two checks of its DNS record (`verify`). */
export const VERIFY_COOLDOWN_SECONDS = 60;

/** Days a verified domain may fail its recheck before it becomes `unverified`. */
export const RECHECK_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A host the console refuses to claim, and why (the message is shown to the owner). */
export class DomainHostError extends Error {
  override name = "DomainHostError";
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC = /^\d+$/;
const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "invalid",
  "example",
  "test",
  "onion",
];

/**
 * A claimable host as the console stores it: lower case, no trailing dot, IDN
 * as punycode. Refused: anything that is not a plain domain name (a scheme, a
 * path, a port, credentials, whitespace), a wildcard, an IP address in any
 * form, `localhost` and the reserved suffixes, a single label, and the
 * platform's own domains (`platformDomain` and everything under it).
 */
export function normalizeDomainHost(
  raw: string,
  platformDomain: string,
): string {
  const text = raw.trim();
  if (text === "") throw new DomainHostError("The domain is empty");
  if (text.includes("*")) {
    throw new DomainHostError("A wildcard domain cannot be claimed");
  }
  if (/[\s/?#@:\\]/.test(text)) {
    throw new DomainHostError(
      "Give a bare host name: no scheme, port, path or credentials",
    );
  }
  const unrooted = text.replace(/\.$/, "");
  const host = domainToASCII(unrooted).toLowerCase();
  if (host === "") throw new DomainHostError("Not a valid domain name");
  if (host.length > 253) throw new DomainHostError("The domain is too long");
  const labels = host.split(".");
  if (labels.length < 2) {
    throw new DomainHostError("A domain needs at least two labels");
  }
  if (!labels.every((label) => LABEL.test(label))) {
    throw new DomainHostError("Not a valid domain name");
  }
  // 192.168.0.1, 0x7f.1 and 2130706433.1 all end in a number: no TLD does.
  const tld = labels[labels.length - 1] as string;
  if (NUMERIC.test(tld) || /^0x[0-9a-f]*$/.test(tld)) {
    throw new DomainHostError("An IP address cannot be claimed");
  }
  if (RESERVED_SUFFIXES.includes(tld)) {
    throw new DomainHostError("This domain is reserved");
  }
  const platform = platformDomain.toLowerCase();
  if (host === platform || host.endsWith(`.${platform}`)) {
    throw new DomainHostError("This is a Clavix domain");
  }
  return host;
}

/** The name of the TXT record that proves control of `host`. */
export const txtNameOf = (host: string) => `_clavix.${host}`;

/** Seconds until a claim checked at `checkedAt` may be checked again; `0` when it may be now. */
export function cooldownSeconds(checkedAt: Date | null, now: Date): number {
  if (checkedAt === null) return 0;
  const waitMs =
    VERIFY_COOLDOWN_SECONDS * 1_000 - (now.getTime() - checkedAt.getTime());
  return waitMs <= 0 ? 0 : Math.ceil(waitMs / 1_000);
}

/** The hosts a tenant's write drops from the cache: the written ones and its slug host. */
export function hostsToForget(
  hosts: string[],
  slugHost: string | undefined,
): string[] {
  return unique([...hosts, ...(slugHost ? [slugHost] : [])]);
}

/** The hosts that resolve to a tenant: its verified ones and its primary, even lapsed. */
export function resolvingHosts(
  verified: string[],
  primary: string | undefined,
): string[] {
  return primary === undefined || verified.includes(primary)
    ? verified
    : [...verified, primary];
}

/** What one recheck of a verified claim decides (`recheckOutcome`). */
export type RecheckOutcome =
  | { kind: "skip" }
  | { kind: "fresh"; clearFailing: boolean }
  | { kind: "failing"; since: Date }
  | { kind: "lapse"; since: Date };

/**
 * A lookup that could not be answered changes nothing; a record that is there
 * clears the failure streak; a failing one keeps its streak start and lapses
 * once the streak reaches `RECHECK_GRACE_DAYS`.
 */
export function recheckOutcome(
  failure: CheckFailure | null,
  claim: Pick<DomainDoc, "failingSince">,
  now: Date,
): RecheckOutcome {
  if (failure === "LOOKUP_FAILED") return { kind: "skip" };
  if (failure === null) {
    return { kind: "fresh", clearFailing: claim.failingSince !== null };
  }
  const since = claim.failingSince ?? now;
  return now.getTime() - since.getTime() < RECHECK_GRACE_DAYS * DAY_MS
    ? { kind: "failing", since }
    : { kind: "lapse", since };
}
