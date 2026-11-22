import type { TypedCollection } from "@softistx/mongo";
import type { SecretBox, SecretResealCounts } from "@/modules/sign-in-methods";
import type { ConnectionDoc, connections } from "../connections.model";
import type {
  ConnectionInput,
  ConnectionPatch,
  ConnectionsFetch,
  ConnectionsOptions,
  HostResolver,
} from "../connections.types";
import { ConnectionDomainsService } from "./domains.service";
import { ConnectionRecordsService } from "./records.service";
import { ConnectionSecretsService } from "./secrets.service";
import { ConnectionSourcesService } from "./sources.service";

/**
 * A tenant's enterprise OIDC connections (M4, F1): the one entry point of the
 * domain, which builds the services of its parts (records, domains, secrets,
 * sources) and hands each call to the right one. Every method takes the
 * tenant's id and reads or writes through its scope, so a connection of A is
 * unknown to B. Each record passes janus's `checkConnection` before it is
 * stored. The client secret is sealed, bound to its tenant and connection, and
 * is never returned or logged.
 */
export class ConnectionsService {
  private readonly records: ConnectionRecordsService;
  private readonly domains: ConnectionDomainsService;
  private readonly secrets: ConnectionSecretsService;
  private readonly sources: ConnectionSourcesService;

  constructor(
    collection: TypedCollection<typeof connections>,
    box: SecretBox,
    options: ConnectionsOptions,
  ) {
    this.records = new ConnectionRecordsService(collection, box, options);
    this.domains = new ConnectionDomainsService(this.records, box, options);
    this.secrets = new ConnectionSecretsService(this.records, box, options.log);
    this.sources = new ConnectionSourcesService(this.records, box, options.log);
  }

  count(tenantId: string): Promise<number> {
    return this.records.count(tenantId);
  }

  list(tenantId: string): Promise<ConnectionDoc[]> {
    return this.records.list(tenantId);
  }

  find(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionDoc | undefined> {
    return this.records.find(tenantId, connectionId);
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

  delete(tenantId: string, connectionId: string): Promise<boolean> {
    return this.records.delete(tenantId, connectionId);
  }

  setSecret(
    tenantId: string,
    connectionId: string,
    clientSecret: string,
  ): Promise<ConnectionDoc> {
    return this.secrets.setSecret(tenantId, connectionId, clientSecret);
  }

  resealSecrets(tenantId: string): Promise<SecretResealCounts> {
    return this.secrets.resealSecrets(tenantId);
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

  requiresSso(tenantId: string, email: string): Promise<boolean> {
    return this.sources.requiresSso(tenantId, email);
  }

  jitAllowed(tenantId: string, connectionId: string): Promise<boolean> {
    return this.sources.jitAllowed(tenantId, connectionId);
  }

  sourceOf(tenantId: string) {
    return this.sources.sourceOf(tenantId);
  }

  isOffered(tenantId: string, doc: ConnectionDoc): boolean {
    return this.sources.isOffered(tenantId, doc);
  }

  /** Specs only: see `ConnectionSourcesService.useHostResolver`. */
  useHostResolver(resolver: HostResolver | undefined): void {
    this.sources.useHostResolver(resolver);
  }

  /** Specs only: see `ConnectionSourcesService.useFetch`. */
  useFetch(fetcher: ConnectionsFetch | undefined): void {
    this.sources.useFetch(fetcher);
  }

  /** The transport `useFetch` set, read when a tenant's instance is built. */
  fetch(): ConnectionsFetch | undefined {
    return this.sources.fetch();
  }

  /** The resolver `useHostResolver` set, read when a tenant's instance is built. */
  resolveHost(): HostResolver | undefined {
    return this.sources.resolveHost();
  }
}
