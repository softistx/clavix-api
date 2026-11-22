import { mintToken, VERIFY_COOLDOWN_SECONDS } from "@/modules/domains";
import type { SecretBox } from "@/modules/sign-in-methods";
import { ConnectionError } from "../connections.errors";
import { assertClaimable } from "../connections.integrity";
import type { ConnectionDoc } from "../connections.model";
import { checked, partsOf } from "../connections.record";
import type { ConnectionsOptions } from "../connections.types";
import { contextOf, normalDomain, txtNameOf } from "../utils";
import type { ConnectionRecordsService } from "./records.service";

/** The e-mail domains a connection claims, and their proof by a TXT record. */
export class ConnectionDomainsService {
  constructor(
    private readonly records: ConnectionRecordsService,
    private readonly box: SecretBox,
    private readonly options: Pick<ConnectionsOptions, "txt" | "now">,
  ) {}

  /** Claims a domain: normalised by janus, a TXT token minted, not verified yet. */
  async addDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<ConnectionDoc> {
    const current = await this.records.get(tenantId, connectionId);
    const secret = this.box.open(
      current.secret,
      contextOf(tenantId, current.connectionId),
    );
    const [normalised] = checked({
      ...partsOf(current, secret, [domain]),
    }).domains;
    if (normalised === undefined) {
      throw new Error("janus returned no domain for the claimed one");
    }
    const scoped = this.records.scoped(tenantId);
    await assertClaimable(scoped, current, normalised);
    return scoped.update(current._id, {
      domains: [
        ...current.domains,
        {
          domain: normalised,
          txtToken: mintToken(),
          verifiedAt: null,
          checkedAt: null,
        },
      ],
      revision: current.revision + 1,
    });
  }

  /**
   * Looks for the TXT record `_clavix-sso.<domain>` holding the token: found,
   * the domain is verified. At most one check per minute and domain
   * (`VERIFY_COOLDOWN`). `false` for a record not (yet) there; the DNS being
   * down is told as `false` too, the cooldown still running.
   */
  async verifyDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<{ connection: ConnectionDoc; verified: boolean }> {
    const current = await this.records.get(tenantId, connectionId);
    domain = normalDomain(domain);
    const entry = current.domains.find((item) => item.domain === domain);
    if (entry === undefined) {
      throw new ConnectionError(
        "NOT_FOUND",
        "No such domain on this connection",
        "domain",
      );
    }
    if (entry.verifiedAt !== null)
      return { connection: current, verified: true };
    const now = this.options.now();
    if (entry.checkedAt !== null) {
      const waitMs =
        VERIFY_COOLDOWN_SECONDS * 1_000 -
        (now.getTime() - entry.checkedAt.getTime());
      if (waitMs > 0) {
        throw new ConnectionError(
          "VERIFY_COOLDOWN",
          "This domain was checked a moment ago; try again shortly",
          "domain",
          Math.ceil(waitMs / 1_000),
        );
      }
    }
    const answer = await this.options.txt.resolveTxt(txtNameOf(domain));
    const verified =
      answer.kind === "records" && answer.values.includes(entry.txtToken);
    const connection = await this.records.scoped(tenantId).update(current._id, {
      domains: current.domains.map((item) =>
        item.domain === domain
          ? { ...item, checkedAt: now, verifiedAt: verified ? now : null }
          : item,
      ),
      revision: current.revision + 1,
    });
    return { connection, verified };
  }

  async removeDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<ConnectionDoc> {
    const current = await this.records.get(tenantId, connectionId);
    domain = normalDomain(domain);
    if (!current.domains.some((entry) => entry.domain === domain)) {
      return current;
    }
    return this.records.scoped(tenantId).update(current._id, {
      domains: current.domains.filter((entry) => entry.domain !== domain),
      revision: current.revision + 1,
    });
  }
}
