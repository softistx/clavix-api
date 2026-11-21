import type { Db } from "mongodb";
import type { SecretResealCounts } from "@/modules/sign-in-methods";

/** What one tenant's pass over the TOTP secrets did (janus's `secondFactor.reseal`, summed over its batches). */
export interface SecondFactorResealCounts {
  scanned: number;
  resealed: number;
  current: number;
  /** Changed meanwhile: run again. */
  skipped: number;
  /** No key of the keyring opens them: left as they are. */
  unreadable: number;
}

/** Seals one partition's TOTP secrets again; the whole pass, batch after batch. */
export type ResealSecondFactor = (
  partition: string,
) => Promise<SecondFactorResealCounts>;

export interface ResealDeps {
  db: Db;
  /** The keyring: the first key is the one every record ends up sealed under. */
  masterKeys: readonly [Uint8Array, ...Uint8Array[]];
  /** Every tenant partition (hex ids), the suspended and the trashed included. */
  tenantIds: () => Promise<string[]>;
  log: (message: string) => void;
  /** Seals a partition's TOTP secrets again; janus's `secondFactor.reseal` under the keyring by default. */
  resealSecondFactor?: ResealSecondFactor;
  /**
   * The stores of Clavix's own sealed secrets, each sealing one tenant's
   * envelopes again under the same keyring. Required: a store left out would
   * be a secret lost when the old key is dropped.
   */
  secretStores: Record<SecretStore, ResealSecretStore>;
}

/** Clavix's own sealed stores (`createSecretBox`), by the name of their counts in the report. */
export const SECRET_STORES = [
  "webhookSecrets",
  "connectionSecrets",
  "socialSecrets",
] as const;
export type SecretStore = (typeof SECRET_STORES)[number];

/** Seals one tenant's envelopes of a store again (`resealSecrets` of its service). */
export type ResealSecretStore = (
  tenantId: string,
) => Promise<SecretResealCounts>;

/** What the reseal report holds before `oldKeyNeededBy` is worked out. */
export type ResealCounts = Omit<ResealReport, "oldKeyNeededBy">;

export interface ResealReport {
  tenants: number;
  resealed: number;
  /** Records already under the first key. */
  current: number;
  /** Records changed by someone else meanwhile: run again. */
  skipped: number;
  /** Tenants whose run threw (a record no key of the list opens). */
  failed: number;
  /**
   * The TOTP secrets, sealed again by janus (`secondFactor.reseal`), and what
   * still sits under an older key afterwards: `behind` counts the secrets,
   * `recoveryCodesBehind` the recovery-code hashes (those cannot be hashed
   * again: they keep working while their key is in the keyring, and new ones
   * are hashed under the first key).
   */
  secondFactor: SecondFactorResealCounts & {
    sealed: number;
    behind: number;
    recoveryCodesBehind: number;
  };
  /** The webhook endpoints' signing secrets, the rolled ones included. */
  webhookSecrets: SecretResealCounts;
  /** The client secrets of the enterprise connections. */
  connectionSecrets: SecretResealCounts;
  /** The client secrets of the tenants' social apps (the trash included). */
  socialSecrets: SecretResealCounts;
  /**
   * Why the old master key must stay in the keyring, one line per count
   * (`webhookSecrets.behind: 2`); empty when it may be dropped.
   */
  oldKeyNeededBy: string[];
}
