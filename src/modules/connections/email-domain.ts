import { domainToASCII } from "node:url";

const MAX_DOMAIN = 253;
const MAX_LABEL = 63;

function wellFormed(domain: string): boolean {
  if (domain.length > MAX_DOMAIN || !domain.includes(".")) return false;
  const labels = domain.split(".");
  for (const label of labels) {
    if (label === "" || label.length > MAX_LABEL) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  return !/^[0-9]+$/.test(labels[labels.length - 1] ?? "");
}

/**
 * The domain of an address as connections store it (lowercase, punycode, no
 * trailing dot), or `null`. It must give exactly what janus-social's
 * `domainOfEmail` gives when it matches a connection, or a domain janus holds
 * is not found here and the SSO gate lets the address through.
 *
 * Temporary, until @softistx/janus-social#945 (it exports `domainOfEmail`; it is
 * internal in 0.6.1 and 0.7.0): then this file is deleted and the export is
 * imported.
 */
export function domainOfEmail(address: string): string | null {
  if (/\s/.test(address)) return null;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@")) return null;
  const trimmed = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (trimmed === "" || /[\s@/:*?#%\\]/.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed).replace(/\.$/, "");
  return wellFormed(ascii) ? ascii : null;
}
