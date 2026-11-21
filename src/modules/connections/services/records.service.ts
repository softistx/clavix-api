import { ObjectId } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods/secrets";
import { assertWithinQuota } from "@/modules/usage/quota";
import { ConnectionError } from "../connections.errors";
import type { ConnectionDoc } from "../connections.model";
import { checked, partsOf } from "../connections.record";
import { nameOf } from "../connections.rules";
import type {
  ConnectionInput,
  ConnectionPatch,
  ConnectionsOptions,
} from "../connections.types";
import { claimsOf, contextOf, nextOf } from "../connections.utils";
import type { ConnectionsReader } from "./connections-reader.service";

/**
 * Creates, updates and removes a tenant's enterprise OIDC connections. Each
 * record passes janus's `checkConnection` before it is stored. The client
 * secret is sealed, bound to its tenant and connection, and is never returned
 * or logged.
 */
export class ConnectionRecordsService {
  constructor(
    private readonly reader: ConnectionsReader,
    private readonly box: SecretBox,
    private readonly options: ConnectionsOptions,
  ) {}

  /**
   * Whether the issuer advertises the `iss` response parameter (RFC 9207), so
   * the record pins it (`requireIssParameter`): a provider that later drops the
   * line cannot lift the requirement. A provider that cannot be read now is
   * `false`; the library still requires `iss` whenever the metadata says so.
   */
  private async issAdvertised(issuer: string): Promise<boolean> {
    const probe = this.options.advertisesIss;
    if (probe === undefined) return false;
    try {
      return await probe(issuer);
    } catch {
      return false;
    }
  }

  /**
   * Creates a connection. The quota check and the insert are not atomic: the
   * caller holds a lock per tenant.
   */
  async create(
    tenantId: string,
    input: ConnectionInput,
    quota: number | null,
  ): Promise<ConnectionDoc> {
    const name = nameOf(input.name);
    const emailTrust = input.emailTrust ?? "claimAndDomain";
    const requireIss = await this.issAdvertised(input.issuer);
    const record = checked({
      connectionId: input.id,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      clientAuthentication: input.clientAuthentication ?? null,
      idTokenSignedResponseAlg: input.idTokenSignedResponseAlg ?? null,
      scopes: input.scopes ?? null,
      emailTrust,
      claims: claimsOf(input.claims),
      domains: [],
      upstreamAcr: input.upstreamMfa?.acr ?? null,
      requireIss,
      revision: 1,
    });
    const scoped = this.reader.scoped(tenantId);
    if (await this.reader.find(tenantId, record.id)) {
      throw new ConnectionError(
        "CONFLICT",
        "A connection with this id already exists",
        "id",
      );
    }
    assertWithinQuota("connections", await scoped.count(), quota);
    return scoped.create({
      _id: new ObjectId(),
      connectionId: record.id,
      name,
      issuer: record.issuer,
      clientId: record.client.id,
      secret: this.box.seal(input.clientSecret, contextOf(tenantId, record.id)),
      clientAuthentication: record.client.authentication ?? null,
      idTokenSignedResponseAlg: record.client.idTokenSignedResponseAlg ?? null,
      scopes:
        input.scopes === undefined || input.scopes === null
          ? null
          : [...(record.scopes ?? [])],
      emailTrust,
      claims: claimsOf(record.claims),
      domains: [],
      requireSso: input.requireSso ?? true,
      jit: input.jit ?? true,
      showButton: input.showButton ?? false,
      upstreamMfa: input.upstreamMfa ?? null,
      requireIss,
      enabled: input.enabled ?? true,
      revision: 1,
    });
  }

  async update(
    tenantId: string,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<ConnectionDoc> {
    const current = await this.reader.get(tenantId, connectionId);
    // A patch never carries the secret (`setSecret` replaces it), so it is
    // not opened: a rename works under a dropped key. The placeholder only
    // satisfies the record's shape check.
    const secret = "unopened-secret";
    const next = nextOf(current, patch);
    const domains = current.domains.map((entry) => entry.domain);
    const requireIss =
      next.issuer === current.issuer
        ? current.requireIss
        : await this.issAdvertised(next.issuer);
    const record = checked({
      connectionId,
      ...next,
      requireIss,
      clientSecret: secret,
      domains,
      revision: current.revision + 1,
    });
    if (record.issuer !== current.issuer) {
      if ((await this.options.links(tenantId, connectionId)) > 0) {
        throw new ConnectionError(
          "CONNECTION_IN_USE",
          "Accounts are linked through this connection: its issuer cannot change. Create a new connection instead",
          "issuer",
        );
      }
    }
    const enabled = patch.enabled ?? current.enabled;
    if (enabled && !current.enabled) {
      await this.reader.assertDomainsFree(tenantId, current, domains);
    }
    return this.reader.scoped(tenantId).update(current._id, {
      ...(patch.name === undefined ? {} : { name: nameOf(patch.name) }),
      issuer: record.issuer,
      clientId: record.client.id,
      clientAuthentication: record.client.authentication ?? null,
      idTokenSignedResponseAlg: record.client.idTokenSignedResponseAlg ?? null,
      scopes: next.scopes === null ? null : [...(record.scopes ?? [])],
      emailTrust: next.emailTrust,
      claims: claimsOf(record.claims),
      ...(patch.requireSso === undefined
        ? {}
        : { requireSso: patch.requireSso }),
      ...(patch.jit === undefined ? {} : { jit: patch.jit }),
      ...(patch.showButton === undefined
        ? {}
        : { showButton: patch.showButton }),
      ...(patch.upstreamMfa === undefined
        ? {}
        : { upstreamMfa: patch.upstreamMfa }),
      requireIss,
      enabled,
      revision: current.revision + 1,
    });
  }

  /** Replaces the client secret (sealed). */
  async setSecret(
    tenantId: string,
    connectionId: string,
    clientSecret: string,
  ): Promise<ConnectionDoc> {
    const current = await this.reader.get(tenantId, connectionId);
    checked(
      partsOf(
        current,
        clientSecret,
        current.domains.map((entry) => entry.domain),
      ),
    );
    return this.reader.scoped(tenantId).update(current._id, {
      secret: this.box.seal(clientSecret, contextOf(tenantId, connectionId)),
      revision: current.revision + 1,
    });
  }

  /** Removes a connection; refused while accounts are linked through it. */
  async delete(tenantId: string, connectionId: string): Promise<boolean> {
    const current = await this.reader.find(tenantId, connectionId);
    if (current === undefined) return false;
    if ((await this.options.links(tenantId, connectionId)) > 0) {
      throw new ConnectionError(
        "CONNECTION_IN_USE",
        "Accounts are linked through this connection: switch it off instead",
      );
    }
    await this.reader.scoped(tenantId).delete(current._id);
    return true;
  }
}
