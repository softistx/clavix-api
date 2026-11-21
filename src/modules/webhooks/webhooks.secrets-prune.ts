export interface SecretsPruneDeps {
  /** The ids (hex) of the tenants whose endpoints are cleaned. */
  tenantIds(): Promise<string[]>;
  /** Drops the tenant's expired rolled secrets; how many endpoints changed. */
  prune(tenantId: string, now: Date): Promise<number>;
  log?: (message: string) => void;
}

export interface SecretsPruneReport {
  /** The endpoints that lost an expired secret. */
  pruned: number;
  /** The tenants a pass could not finish; the next run takes them again. */
  failed: number;
}

/**
 * The daily clean-up of the rolled webhook secrets (D19). An expired secret is
 * already ignored at send time, so this only removes what is stored: late is
 * harmless, and the pass is idempotent. A tenant that fails is logged and
 * counted, the others go on.
 */
export async function pruneWebhookSecrets(
  deps: SecretsPruneDeps,
  now: Date = new Date(),
): Promise<SecretsPruneReport> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const report: SecretsPruneReport = { pruned: 0, failed: 0 };
  for (const tenantId of await deps.tenantIds()) {
    try {
      report.pruned += await deps.prune(tenantId, now);
    } catch (error) {
      report.failed += 1;
      log(
        `webhooks: could not prune the secrets of ${tenantId}: ${String(error)}`,
      );
    }
  }
  return report;
}
