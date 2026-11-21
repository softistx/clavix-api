import {
  type ConnectionSource,
  domainOfEmail,
  type OidcConnection,
} from "@softistx/janus-social";
import type { SecretBox } from "@/modules/sign-in-methods/secrets";
import type { ConnectionDoc } from "../connections.model";
import { checked, partsOf } from "../connections.record";
import type { ConnectionsFetch, HostResolver } from "../connections.types";
import { contextOf } from "../connections.utils";
import type { ConnectionsReader } from "./connections-reader.service";

/** What sign-in reads of a tenant's connections: who owns a domain, what janus may open. */
export class ConnectionSignInService {
  private hostResolver: HostResolver | undefined;
  private fetcher: ConnectionsFetch | undefined;

  constructor(
    private readonly reader: ConnectionsReader,
    private readonly box: SecretBox,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * The one enabled connection that owns a verified domain, or `undefined`.
   * Two enabled connections claiming one domain answer nothing (logged),
   * so neither can take the other's sign-ins.
   */
  private async ownerOf(
    tenantId: string,
    domain: string,
  ): Promise<ConnectionDoc | undefined> {
    const found = (
      await this.reader.scoped(tenantId).findMany({
        filter: { enabled: true, "domains.domain": domain },
      })
    ).filter((doc) =>
      doc.domains.some((d) => d.domain === domain && d.verifiedAt !== null),
    );
    if (found.length > 1) {
      this.log(
        `connections: ${found.length} enabled connections of tenant ${tenantId} claim one domain; none answers`,
      );
      return undefined;
    }
    return found[0];
  }

  /**
   * Whether the address belongs to a verified domain of an enabled connection
   * that requires single sign-on (D3): every other way in is refused for it.
   */
  async requiresSso(tenantId: string, email: string): Promise<boolean> {
    const domain = domainOfEmail(email);
    if (domain === null) return false;
    return (await this.ownerOf(tenantId, domain))?.requireSso === true;
  }

  /**
   * Whether a connection of the tenant may create a user at a first sign-in
   * (D4, `jit`). Read on every sign-up, so turning it off takes effect at once.
   */
  async jitAllowed(tenantId: string, connectionId: string): Promise<boolean> {
    const doc = await this.reader.find(tenantId, connectionId);
    return doc?.enabled === true && doc.jit;
  }

  /** Specs only: answers the addresses of a host with no real DNS. Production leaves it unset. */
  useHostResolver(resolver: HostResolver | undefined): void {
    this.hostResolver = resolver;
  }

  /**
   * Specs only: replaces the transport of every request to an identity
   * provider (janus-social 0.10 otherwise connects to the checked addresses
   * itself, past the global `fetch`). Production leaves it unset: no production
   * file calls it, which `spec-seams.spec.ts` enforces.
   */
  useFetch(fetcher: ConnectionsFetch | undefined): void {
    this.fetcher = fetcher;
  }

  /** The transport `useFetch` set, read when a tenant's instance is built. */
  fetch(): ConnectionsFetch | undefined {
    return this.fetcher;
  }

  /** The resolver `useHostResolver` set, read when a tenant's instance is built. */
  resolveHost(): HostResolver | undefined {
    return this.hostResolver;
  }

  /**
   * The tenant's connections as janus's `oidcConnections` reads them: enabled
   * ones with a verified domain, the secret opened. Anything that cannot be
   * built is not offered (logged by id only) and a domain two connections
   * claim answers nothing.
   */
  sourceOf(tenantId: string): ConnectionSource {
    return {
      findConnection: async (id) => {
        const doc = await this.reader.find(tenantId, id);
        return doc === undefined ? null : this.build(tenantId, doc);
      },
      findConnectionByDomain: async (domain) => {
        const only = await this.ownerOf(tenantId, domain);
        return only === undefined ? null : this.build(tenantId, only);
      },
    };
  }

  /**
   * Whether the connection can be opened now (`build` accepts it): what is
   * offered on the sign-in page and what `socialSignInStart` accepts, one
   * predicate so the two cannot drift.
   */
  isOffered(tenantId: string, doc: ConnectionDoc): boolean {
    return this.build(tenantId, doc) !== null;
  }

  private build(tenantId: string, doc: ConnectionDoc): OidcConnection | null {
    if (!doc.enabled) return null;
    const verified = doc.domains
      .filter((entry) => entry.verifiedAt !== null)
      .map((entry) => entry.domain);
    if (verified.length === 0) return null;
    try {
      const secret = this.box.open(
        doc.secret,
        contextOf(tenantId, doc.connectionId),
      );
      return checked(partsOf(doc, secret, verified));
    } catch (error) {
      // The connection's id and the error's name only: a message could quote the record.
      this.log(
        `connections: ${doc.connectionId} of tenant ${tenantId} is off (${error instanceof Error ? error.name : "unknown error"})`,
      );
      return null;
    }
  }
}
