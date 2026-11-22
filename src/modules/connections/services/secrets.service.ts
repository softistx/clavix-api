import {
  emptySecretResealCounts,
  type SecretBox,
  type SecretResealCounts,
} from "@/modules/sign-in-methods";
import type { ConnectionDoc } from "../connections.model";
import { checked, partsOf } from "../connections.record";
import { contextOf } from "../utils";
import type { ConnectionRecordsService } from "./records.service";

/** The sealed client secrets of a tenant's connections: replaced, and sealed again on a master-key rotation. */
export class ConnectionSecretsService {
  constructor(
    private readonly records: ConnectionRecordsService,
    private readonly box: SecretBox,
    private readonly log: (message: string) => void,
  ) {}

  /** Replaces the client secret (sealed). */
  async setSecret(
    tenantId: string,
    connectionId: string,
    clientSecret: string,
  ): Promise<ConnectionDoc> {
    const current = await this.records.get(tenantId, connectionId);
    checked(
      partsOf(
        current,
        clientSecret,
        current.domains.map((entry) => entry.domain),
      ),
    );
    return this.records.scoped(tenantId).update(current._id, {
      secret: this.box.seal(clientSecret, contextOf(tenantId, connectionId)),
      revision: current.revision + 1,
    });
  }

  /**
   * Seals the tenant's client secrets again under the keyring's first key
   * (`keys:reseal`, a master-key rotation). An envelope is replaced only if
   * it is still the one read, so a secret set meanwhile is never overwritten
   * (`skipped`: run again). One no key opens is left as it is and logged by
   * connection id (`unreadable`).
   */
  async resealSecrets(tenantId: string): Promise<SecretResealCounts> {
    const counts = emptySecretResealCounts();
    const scoped = this.records.scoped(tenantId);
    for (const doc of await scoped.findMany({})) {
      counts.scanned += 1;
      if (doc.secret.kid === this.box.kid) {
        counts.current += 1;
        continue;
      }
      let secret: ReturnType<SecretBox["reseal"]>;
      try {
        secret = this.box.reseal(
          doc.secret,
          contextOf(tenantId, doc.connectionId),
        );
      } catch {
        counts.unreadable += 1;
        this.log(
          `connections: the secret of ${doc.connectionId} (tenant ${tenantId}) could not be sealed again`,
        );
        continue;
      }
      const written = await scoped.updateMany(
        { _id: doc._id, "secret.ct": doc.secret.ct },
        { $set: { secret }, $inc: { revision: 1 } },
      );
      if (written > 0) counts.resealed += 1;
      else counts.skipped += 1;
    }
    counts.behind = await scoped.count({
      "secret.kid": { $ne: this.box.kid },
    });
    return counts;
  }
}
