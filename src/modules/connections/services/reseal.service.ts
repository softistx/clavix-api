import {
  emptySecretResealCounts,
  type SecretBox,
  type SecretResealCounts,
} from "@/modules/sign-in-methods/secrets";
import { contextOf } from "../connections.utils";
import type { ConnectionsReader } from "./connections-reader.service";

/** Seals the client secrets again under the keyring's first key (`keys:reseal`). */
export class ConnectionResealService {
  constructor(
    private readonly reader: ConnectionsReader,
    private readonly box: SecretBox,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Seals the tenant's client secrets again under the keyring's first key
   * (`keys:reseal`, a master-key rotation). An envelope is replaced only if
   * it is still the one read, so a secret set meanwhile is never overwritten
   * (`skipped`: run again). One no key opens is left as it is and logged by
   * connection id (`unreadable`).
   */
  async resealSecrets(tenantId: string): Promise<SecretResealCounts> {
    const counts = emptySecretResealCounts();
    const scoped = this.reader.scoped(tenantId);
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
