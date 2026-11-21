import { WebhookError } from "./webhooks.errors";
import { isWebhookEventType } from "./webhooks.events";
import type { EndpointSecret } from "./webhooks.model";
import type {
  EndpointChanges,
  EndpointPatch,
  WebhookEndpointDoc,
} from "./webhooks.types";

/** What a rolled secret keeps signing for (D19). */
export const ROLL_OVERLAP_MS = 24 * 60 * 60 * 1000;
/** Given-up deliveries in a row after which an endpoint is switched off (D20). */
export const GIVE_UP_LIMIT = 5;
/** The secrets an endpoint keeps at most: the current one and the last rolled ones. */
export const MAX_SECRETS = 3;
/** The longest description an endpoint takes. */
export const DESCRIPTION_MAX = 200;

/** The event types, once each; an unknown one is `BAD_USER_INPUT` on `types`. */
export function typesOf(types: readonly string[] | undefined): string[] {
  const unique = [...new Set(types ?? [])];
  const unknown = unique.find((type) => !isWebhookEventType(type));
  if (unknown !== undefined) {
    throw new WebhookError(
      "BAD_USER_INPUT",
      `Unknown event type "${unknown}"`,
      "types",
    );
  }
  return unique;
}

/** The description trimmed; `undefined` stays; too long is `BAD_USER_INPUT`. */
export function descriptionOf(
  description: string | undefined,
): string | undefined {
  if (description === undefined) return undefined;
  const trimmed = description.trim();
  if (trimmed.length > DESCRIPTION_MAX) {
    throw new WebhookError(
      "BAD_USER_INPUT",
      `The description is longer than ${DESCRIPTION_MAX} characters`,
      "description",
    );
  }
  return trimmed;
}

/**
 * What an update writes, from the endpoint as it is and the patch. The
 * address is only normalised here: the service checks it. Switching on by
 * hand clears what the auto-disable left (D20).
 */
export function endpointChanges(
  current: WebhookEndpointDoc,
  patch: EndpointPatch,
): EndpointChanges {
  const set: EndpointChanges = {};
  if (patch.url !== undefined && patch.url !== current.url) {
    set.url = new URL(patch.url).href;
  }
  const description = descriptionOf(patch.description);
  if (description !== undefined) set.description = description;
  if (patch.types !== undefined) set.types = typesOf(patch.types);
  if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
    set.enabled = patch.enabled;
    set.disabledReason = patch.enabled ? null : "manual";
    if (patch.enabled) set.consecutiveGiveUps = 0;
  }
  return set;
}

/**
 * The secrets after a roll: the new one first, then (with `keepPrevious`) the
 * ones still valid, each capped at `until`; the list never passes `MAX_SECRETS`.
 */
export function rolledSecrets(
  fresh: EndpointSecret,
  previous: readonly EndpointSecret[],
  keepPrevious: boolean,
  now: Date,
): EndpointSecret[] {
  const until = new Date(now.getTime() + ROLL_OVERLAP_MS);
  const kept = keepPrevious
    ? previous
        .filter((entry) => entry.expiresAt === null || entry.expiresAt > now)
        .map((entry) =>
          entry.expiresAt === null || entry.expiresAt > until
            ? { ...entry, expiresAt: until }
            : entry,
        )
    : [];
  return [fresh, ...kept].slice(0, MAX_SECRETS);
}

/** Whether a secret still signs at `now`. */
export function isLive(entry: EndpointSecret, now: Date): boolean {
  return entry.expiresAt === null || entry.expiresAt > now;
}
