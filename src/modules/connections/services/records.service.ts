import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { SecretBox } from "@/modules/sign-in-methods";
import { assertWithinQuota } from "@/modules/usage";
import { ConnectionError } from "../connections.errors";
import {
  assertDomainsFree,
  assertUnlinked,
  type ConnectionsScope,
} from "../connections.integrity";
import type { ConnectionDoc, connections } from "../connections.model";
import { checked } from "../connections.record";
import { nameOf } from "../connections.rules";
import type {
  ConnectionInput,
  ConnectionPatch,
  ConnectionsOptions,
} from "../connections.types";
import { changesOf, claimsOf, contextOf, newDocOf, nextOf } from "../utils";

/**
 * A tenant's connection records: the reads every other service of the module
 * goes through, and the writes of a record's own fields (create, update,
 * delete). Every method takes the tenant's id and works through its scope, so
 * a connection of A is unknown to B.
 */
export class ConnectionRecordsService {
  constructor(
    private readonly collection: TypedCollection<typeof connections>,
    private readonly box: SecretBox,
    private readonly options: ConnectionsOptions,
  ) {}

  scoped(tenantId: string): ConnectionsScope {
    return scopeToTenant(this.collection, new ObjectId(tenantId));
  }

  count(tenantId: string): Promise<number> {
    return this.scoped(tenantId).count();
  }

  list(tenantId: string): Promise<ConnectionDoc[]> {
    return this.scoped(tenantId).findMany({ sort: { createdAt: 1 } });
  }

  async find(
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionDoc | undefined> {
    const [found] = await this.scoped(tenantId).findMany({
      filter: { connectionId },
      limit: 1,
    });
    return found;
  }

  async get(tenantId: string, connectionId: string): Promise<ConnectionDoc> {
    const found = await this.find(tenantId, connectionId);
    if (found === undefined) {
      throw new ConnectionError("NOT_FOUND", "No such connection");
    }
    return found;
  }

  /**
   * Whether the issuer advertises the `iss` response parameter (RFC 9207), so
   * the record pins it (`requireIssParameter`): a provider that later drops the
   * line cannot lift the requirement. A provider that cannot be read now is
   * `false`; the library still requires `iss` whenever the metadata says so.
   */
  private async issAdvertised(issuer: string): Promise<boolean> {
    try {
      return await this.options.advertisesIss(issuer);
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
    if (await this.find(tenantId, record.id)) {
      throw new ConnectionError(
        "CONFLICT",
        "A connection with this id already exists",
        "id",
      );
    }
    const scoped = this.scoped(tenantId);
    assertWithinQuota("connections", await scoped.count(), quota);
    const secret = this.box.seal(
      input.clientSecret,
      contextOf(tenantId, record.id),
    );
    return scoped.create(
      newDocOf({
        id: new ObjectId(),
        input,
        record,
        name,
        emailTrust,
        requireIss,
        secret,
      }),
    );
  }

  async update(
    tenantId: string,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<ConnectionDoc> {
    const current = await this.get(tenantId, connectionId);
    // A patch never carries the secret (`setSecret` replaces it), so it is
    // not opened: a rename works under a dropped key. The placeholder only
    // satisfies the record's shape check.
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
      clientSecret: "unopened-secret",
      domains,
      revision: current.revision + 1,
    });
    if (record.issuer !== current.issuer) {
      await assertUnlinked(
        this.options.links,
        tenantId,
        connectionId,
        "Accounts are linked through this connection: its issuer cannot change. Create a new connection instead",
        "issuer",
      );
    }
    const enabled = patch.enabled ?? current.enabled;
    if (enabled && !current.enabled) {
      await assertDomainsFree(this.scoped(tenantId), current, domains);
    }
    return this.scoped(tenantId).update(
      current._id,
      changesOf({
        patch,
        current,
        next,
        record,
        name: patch.name === undefined ? undefined : nameOf(patch.name),
        requireIss,
        enabled,
      }),
    );
  }

  /** Removes a connection; refused while accounts are linked through it. */
  async delete(tenantId: string, connectionId: string): Promise<boolean> {
    const current = await this.find(tenantId, connectionId);
    if (current === undefined) return false;
    await assertUnlinked(
      this.options.links,
      tenantId,
      connectionId,
      "Accounts are linked through this connection: switch it off instead",
    );
    await this.scoped(tenantId).delete(current._id);
    return true;
  }
}
