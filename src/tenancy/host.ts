import { slugProblem } from "@/modules/tenants";

// The host a request was addressed to, and the tenant slug it names. The host
// comes from the request URL (`new URL(request.url).host`: the `Host` header);
// `X-Forwarded-Host` is never read, since a client could set it (owner
// decision D3, slice 1.1).

/** `host[:port]` of the request URL, normalised (see `normalizeHost`). */
export function hostOfRequest(request: Request): string | null {
  try {
    return normalizeHost(new URL(request.url).host);
  } catch {
    return null;
  }
}

/**
 * Lowercase, port and trailing dot removed, IDN as punycode (the URL parser
 * does the last). `null` for an empty or unparsable host and for an IP.
 */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /[/?#@\s]/.test(trimmed)) return null;
  let hostname: string;
  try {
    hostname = new URL(`http://${trimmed}`).hostname;
  } catch {
    return null;
  }
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "" || isIp(host)) return null;
  return host;
}

// IPv6 hostnames keep their brackets; IPv4 (any form the URL parser accepts)
// is normalised to dotted decimal.
const isIp = (host: string) =>
  host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/**
 * The slug of `<slug>.<domain>`, or `null`: not under the domain, the apex
 * itself, more than one label before it, or a label that is not a valid,
 * unreserved slug. `host` is already normalised.
 */
export function slugOfHost(host: string, domain: string): string | null {
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return slugProblem(label) === undefined ? label : null;
}
