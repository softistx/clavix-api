import { domainToASCII } from "node:url";

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
