import type { ConnectionSource } from "@softistx/janus-social";
import type { TypedCollection } from "@softistx/mongo";
import type {
  SecretBox,
  SecretResealCounts,
} from "@/modules/sign-in-methods/secrets";
import type { ConnectionDoc, connections } from "../connections.model";
import type {
  ConnectionInput,
  ConnectionPatch,
  ConnectionsFetch,
  ConnectionsOptions,
  HostResolver,
} from "../connections.types";
import { ConnectionsReader } from "./connections-reader.service";
import { ConnectionDomainsService } from "./domains.service";
import { ConnectionRecordsService } from "./records.service";
import { ConnectionResealService } from "./reseal.service";
import { ConnectionSignInService } from "./sign-in.service";

/**
 * A tenant's enterprise OIDC connections (M4, F1). Every method takes the
 * tenant's id and reads or writes through its scope, so a connection of A is
 * unknown to B. The facade of the module's services: records, domains, sign-in
 * reads and the secrets' reseal.
 */
export class ConnectionsService {
  private readonly reader: ConnectionsReader;
  private readonly records: ConnectionRecordsService;
  private readonly domains: ConnectionDomainsService;
  private readonly signIn: ConnectionSignInService;
  private readonly resealer: ConnectionResealService;

  constructor(
    collection: TypedCollection<typeof connections>,
    box: SecretBox,
    options: ConnectionsOptions,
  ) {
    const now = options.now ?? (() => new Date());
    const log = options.log ?? ((message) => console.warn(message));
    this.reader = new ConnectionsReader(collection);
    this.records = new ConnectionRecordsService(this.reader, box, options);
    this.domains = new ConnectionDomainsService(this.reader, box, options, now);
    this.signIn = new ConnectionSignInService(this.reader, box, log);
    this.resealer = new ConnectionResealService(this.reader, box, log);
  }

  count(tenantId: string): Promise<number> {
    return this.reader.count(tenantId);
  }

  list(tenantId: string): Promise<ConnectionDoc[]> {
    return this.reader.list(tenantId);
  }

  find(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionDoc | undefined> {
    return this.reader.find(tenantId, connectionId);
  }

  create(
    tenantId: string,
    input: ConnectionInput,
    quota: number | null,
  ): Promise<ConnectionDoc> {
    return this.records.create(tenantId, input, quota);
  }

  update(
    tenantId: string,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<ConnectionDoc> {
    return this.records.update(tenantId, connectionId, patch);
  }

  /** Replaces the client secret (sealed). */
  setSecret(
    tenantId: string,
    connectionId: string,
    clientSecret: string,
  ): Promise<ConnectionDoc> {
    return this.records.setSecret(tenantId, connectionId, clientSecret);
  }

  /** Removes a connection; refused while accounts are linked through it. */
  delete(tenantId: string, connectionId: string): Promise<boolean> {
    return this.records.delete(tenantId, connectionId);
  }

  /** Seals the tenant's client secrets again under the keyring's first key. */
  resealSecrets(tenantId: string): Promise<SecretResealCounts> {
    return this.resealer.resealSecrets(tenantId);
  }

  addDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<ConnectionDoc> {
    return this.domains.addDomain(tenantId, connectionId, domain);
  }

  verifyDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<{ connection: ConnectionDoc; verified: boolean }> {
    return this.domains.verifyDomain(tenantId, connectionId, domain);
  }

  removeDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<ConnectionDoc> {
    return this.domains.removeDomain(tenantId, connectionId, domain);
  }

  /** Whether the address belongs to a verified domain of a connection that requires single sign-on (D3). */
  requiresSso(tenantId: string, email: string): Promise<boolean> {
    return this.signIn.requiresSso(tenantId, email);
  }

  /** Whether a connection of the tenant may create a user at a first sign-in (D4). */
  jitAllowed(tenantId: string, connectionId: string): Promise<boolean> {
    return this.signIn.jitAllowed(tenantId, connectionId);
  }

  /** Specs only: answers the addresses of a host with no real DNS. */
  useHostResolver(resolver: HostResolver | undefined): void {
    this.signIn.useHostResolver(resolver);
  }

  /** Specs only: replaces the transport of every request to an identity provider. */
  useFetch(fetcher: ConnectionsFetch | undefined): void {
    this.signIn.useFetch(fetcher);
  }

  /** The transport `useFetch` set, read when a tenant's instance is built. */
  fetch(): ConnectionsFetch | undefined {
    return this.signIn.fetch();
  }

  /** The resolver `useHostResolver` set, read when a tenant's instance is built. */
  resolveHost(): HostResolver | undefined {
    return this.signIn.resolveHost();
  }

  /** The tenant's connections as janus's `oidcConnections` reads them. */
  sourceOf(tenantId: string): ConnectionSource {
    return this.signIn.sourceOf(tenantId);
  }

  /** Whether the connection can be opened now: what the sign-in page offers. */
  isOffered(tenantId: string, doc: ConnectionDoc): boolean {
    return this.signIn.isOffered(tenantId, doc);
  }
}
