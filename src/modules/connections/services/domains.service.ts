import {
  mintToken,
  VERIFY_COOLDOWN_SECONDS,
} from "@/modules/domains/domains.verify";
import type { SecretBox } from "@/modules/sign-in-methods/secrets";
import { ConnectionError } from "../connections.errors";
import type { ConnectionDoc } from "../connections.model";
import { checked, partsOf } from "../connections.record";
import { MAX_DOMAINS } from "../connections.rules";
import type { ConnectionsOptions } from "../connections.types";
import { contextOf, normalDomain, txtNameOf } from "../connections.utils";
import type { ConnectionsReader } from "./connections-reader.service";

/** The e-mail domains a connection claims, and the TXT proof of each. */
export class ConnectionDomainsService {
  constructor(
    private readonly reader: ConnectionsReader,
    private readonly box: SecretBox,
    private readonly options: ConnectionsOptions,
    private readonly now: () => Date,
  ) {}

  /** Claims a domain: normalised by janus, a TXT token minted, not verified yet. */
  async addDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<ConnectionDoc> {
    const current = await this.reader.get(tenantId, connectionId);
    const secret = this.box.open(
      current.secret,
      contextOf(tenantId, current.connectionId),
    );
    const normalised = checked({
      ...partsOf(current, secret, [domain]),
    }).domains[0] as string;
    if (current.domains.some((entry) => entry.domain === normalised)) {
      throw new ConnectionError(
        "CONFLICT",
        "This domain is already on the connection",
        "domain",
      );
    }
    if (current.domains.length >= MAX_DOMAINS) {
      throw new ConnectionError(
        "BAD_USER_INPUT",
        `A connection holds at most ${MAX_DOMAINS} domains`,
        "domain",
      );
    }
    const held = await this.reader.scoped(tenantId).findMany({
      filter: { "domains.domain": normalised },
    });
    if (held.length > 0) {
      throw new ConnectionError(
        "DOMAIN_TAKEN",
        "This domain is already on a connection of this tenant",
        "domain",
      );
    }
    return this.reader.scoped(tenantId).update(current._id, {
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
    const current = await this.reader.get(tenantId, connectionId);
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
    const now = this.now();
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
    const connection = await this.reader.scoped(tenantId).update(current._id, {
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
    const current = await this.reader.get(tenantId, connectionId);
    domain = normalDomain(domain);
    if (!current.domains.some((entry) => entry.domain === domain)) {
      return current;
    }
    return this.reader.scoped(tenantId).update(current._id, {
      domains: current.domains.filter((entry) => entry.domain !== domain),
      revision: current.revision + 1,
    });
  }
}
