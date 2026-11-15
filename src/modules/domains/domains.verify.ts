import { ConflictError, type TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import { DomainError } from "./domains.errors";
import type { DomainDoc, domains } from "./domains.model";
import type { DomainSystemEvent } from "./events";

/** Seconds a claim must wait between two checks of its DNS record (`verify`). */
export const VERIFY_COOLDOWN_SECONDS = 60;

/** The TXT value to publish: random per claim, so it names this tenant's claim on this host. */
export const mintToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `clavix-verify=${Buffer.from(bytes).toString("base64url")}`;
};

export const domainTaken = () =>
  new DomainError(
    "DOMAIN_TAKEN",
    "This domain is already verified by another tenant",
  );

/** Refuses a claim checked less than `VERIFY_COOLDOWN_SECONDS` ago (`VERIFY_COOLDOWN`, `retryAfter`). */
export function assertOutsideCooldown(claim: DomainDoc, now: Date) {
  if (claim.checkedAt === null) return;
  const waitMs =
    VERIFY_COOLDOWN_SECONDS * 1_000 -
    (now.getTime() - claim.checkedAt.getTime());
  if (waitMs <= 0) return;
  throw new DomainError(
    "VERIFY_COOLDOWN",
    "This domain was checked a moment ago; try again shortly",
    Math.ceil(waitMs / 1_000),
  );
}

/** What a verification tells the store: the hosts to forget, a system event. */
export interface PromoteHooks {
  changed(tenantId: ObjectId, hosts: string[]): Promise<void>;
  emit(event: DomainSystemEvent): Promise<void>;
}

// Verification: the unique index on verified hosts decides a race; the
// winner then evicts every other pending (or lapsed) claim on the host.
export async function promoteClaim(
  collection: TypedCollection<typeof domains>,
  claim: DomainDoc,
  now: Date,
  { changed, emit }: PromoteHooks,
): Promise<DomainDoc> {
  let verified: DomainDoc;
  try {
    verified = await collection.update(claim._id, {
      status: "verified",
      verifiedAt: now,
      checkedAt: now,
      failingSince: null,
    });
  } catch (error) {
    if (error instanceof ConflictError) throw domainTaken();
    throw error;
  }
  const evicted = await collection.findMany({
    filter: { host: claim.host, _id: { $ne: claim._id } },
  });
  await collection.deleteMany({
    host: claim.host,
    _id: { $ne: claim._id },
  });
  // A lapsed primary evicted here moves its tenant's issuer back to the
  // slug host: that tenant's cached entries must go too.
  for (const loser of evicted) {
    if (loser.primary) await changed(loser.tenantId, [claim.host]);
    await emit({
      action: "domain.evict",
      tenantId: loser.tenantId,
      domainId: loser._id,
    });
  }
  await changed(claim.tenantId, [claim.host]);
  return verified;
}
