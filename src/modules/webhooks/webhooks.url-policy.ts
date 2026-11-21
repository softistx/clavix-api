import { isIP } from "node:net";
import { isPublicAddress } from "@softistx/janus-oauth";
import { WebhookUrlError } from "./webhooks.errors";

/** Resolves a host name to its addresses (A and AAAA); injected so a spec can stand a DNS rebinding in. */
export type Resolve = (host: string) => Promise<string[]>;

export interface UrlPolicy {
  resolve: Resolve;
  /** Private and loopback addresses allowed (`CLAVIX_WEBHOOKS_ALLOW_PRIVATE`, refused in production). */
  allowPrivate: boolean;
}

export const MAX_URL_LENGTH = 2000;

/** The URL's shape (D21): `https` only, no credentials. No lookup; the address is checked by `checkAddress`. */
export function parseWebhookUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new WebhookUrlError(
      "invalid",
      `The URL is longer than ${MAX_URL_LENGTH} characters`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("invalid", "Not a URL");
  }
  if (url.protocol !== "https:") {
    throw new WebhookUrlError("notHttps", "The URL must start with https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebhookUrlError("credentials", "The URL holds credentials");
  }
  return url;
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "");

/**
 * Whether the host reaches public addresses only (D21): an IP literal is
 * checked as it is, a name by every address it resolves to. A name that does
 * not resolve is refused.
 */
export async function checkAddress(
  hostname: string,
  policy: UrlPolicy,
): Promise<void> {
  const host = bare(hostname);
  if (policy.allowPrivate) return;
  const addresses = isIP(host) === 0 ? await lookup(host, policy) : [host];
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new WebhookUrlError(
      "notPublic",
      "The URL does not point to a public address",
    );
  }
}

async function lookup(host: string, policy: UrlPolicy): Promise<string[]> {
  try {
    return await policy.resolve(host);
  } catch {
    throw new WebhookUrlError("notPublic", "The host does not resolve");
  }
}

/** The whole check of a URL given to the console: its shape, then its addresses. */
export async function checkWebhookUrl(
  raw: string,
  policy: UrlPolicy,
): Promise<URL> {
  const url = parseWebhookUrl(raw);
  await checkAddress(url.hostname, policy);
  return url;
}

/**
 * The `fetch` webhooks are sent with (D21): the address is checked again on
 * every send, so a name that now resolves to a private address (DNS
 * rebinding) is refused, and a redirect is never followed. A check and the
 * connection resolve the name separately, so a very short TTL could still
 * answer differently between the two; the delivery then reaches an address
 * chosen by the receiver's own DNS only. Pinning the address would need
 * a fetch that takes one.
 */
export function guardedFetch(
  policy: UrlPolicy,
  send: typeof fetch,
): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = parseWebhookUrl(raw);
    await checkAddress(url.hostname, policy);
    return send(input, { ...init, redirect: "manual" });
  };
  return Object.assign(guarded, { preconnect: send.preconnect });
}
