import {
  type ConnectionSource,
  domainOfEmail,
  type OidcConnection,
  type OidcConnectionsOptions,
} from "@softistx/janus-social";
import { scopeToTenant, type TypedCollection } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { TxtResolver } from "@/modules/domains/dns";
import {
  mintToken,
  VERIFY_COOLDOWN_SECONDS,
} from "@/modules/domains/domains.verify";
import {
  emptySecretResealCounts,
  type SecretBox,
  type SecretResealCounts,
} from "@/modules/sign-in-methods/secrets";
import { assertWithinQuota } from "@/modules/usage/quota";
import { ConnectionError } from "./connections.errors";
import type {
  ConnectionDoc,
  ConnectionEmailTrust,
  connections,
} from "./connections.model";
import { checked, partsOf } from "./connections.record";

export type { ConnectionDoc } from "./connections.model";

/** Where the TXT record of an e-mail domain goes: apart from the custom domains' `_clavix`. */
export const txtNameOf = (domain: string) => `_clavix-sso.${domain}`;

/** The domains one connection may hold. */
export const MAX_DOMAINS = 20;

/** The accounts linked through a connection, counted by the identity store (`CONNECTION_IN_USE`). */
export type LinkCounter = (
  tenantId: string,
  connectionId: string,
) => Promise<number>;

export interface ConnectionInput {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clientAuthentication?: "post" | "basic" | null | undefined;
  idTokenSignedResponseAlg?: string | null | undefined;
  scopes?: readonly string[] | null | undefined;
  emailTrust?: ConnectionEmailTrust | undefined;
  claims?: ClaimsInput | null | undefined;
  requireSso?: boolean | undefined;
  jit?: boolean | undefined;
  showButton?: boolean | undefined;
  upstreamMfa?: { acr: string } | null | undefined;
  enabled?: boolean | undefined;
}

export interface ClaimsInput {
  email?: string | null | undefined;
  emailVerified?: string | null | undefined;
  name?: string | null | undefined;
  picture?: string | null | undefined;
}

/** Fields left out stay as they are; `null` clears an optional one. */
export type ConnectionPatch = Partial<
  Omit<ConnectionInput, "id" | "clientSecret">
>;

/** How the guard resolves an identity provider's host; `node:dns` by default. */
export type HostResolver = NonNullable<OidcConnectionsOptions["resolveHost"]>;
export type ConnectionsFetch = NonNullable<OidcConnectionsOptions["fetch"]>;

export interface ConnectionsOptions {
  txt: TxtResolver;
  links: LinkCounter;
  /** Reads the issuer's metadata: whether it advertises the `iss` response parameter (RFC 9207). Absent: never pinned. */
  advertisesIss?: (issuer: string) => Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
}

const contextOf = (tenantId: string, connectionId: string) =>
  `${tenantId}:${connectionId}`;

const claimsOf = (claims: ClaimsInput | null | undefined) => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(claims ?? {})) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
};

function nameOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 100) {
    throw new ConnectionError(
      "BAD_USER_INPUT",
      "The name is 1 to 100 characters",
      "name",
    );
  }
  return trimmed;
}

/**
 * A tenant's enterprise OIDC connections (M4, F1). Every method takes the
 * tenant's id and reads or writes through its scope, so a connection of A is
 * unknown to B. Each record passes janus's `checkConnection` before it is
 * stored. The client secret is sealed, bound to its tenant and connection,
 * and is never returned or logged.
 */
export class ConnectionsService {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private hostResolver: HostResolver | undefined;
  private fetcher: ConnectionsFetch | undefined;

  constructor(
    private readonly collection: TypedCollection<typeof connections>,
    private readonly box: SecretBox,
    private readonly options: ConnectionsOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
  }

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

  private scoped(tenantId: string) {
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

  private async get(tenantId: string, connectionId: string) {
    const found = await this.find(tenantId, connectionId);
    if (found === undefined) {
      throw new ConnectionError("NOT_FOUND", "No such connection");
    }
    return found;
  }

  /** The record janus would read, for a stored document (secret opened). */
  private openSecret(tenantId: string, doc: ConnectionDoc): string {
    return this.box.open(doc.secret, contextOf(tenantId, doc.connectionId));
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
    const scoped = this.scoped(tenantId);
    if (await this.find(tenantId, record.id)) {
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
    const current = await this.get(tenantId, connectionId);
    const secret = this.openSecret(tenantId, current);
    const next = {
      issuer: patch.issuer ?? current.issuer,
      clientId: patch.clientId ?? current.clientId,
      clientAuthentication:
        patch.clientAuthentication === undefined
          ? current.clientAuthentication
          : patch.clientAuthentication,
      idTokenSignedResponseAlg:
        patch.idTokenSignedResponseAlg === undefined
          ? current.idTokenSignedResponseAlg
          : patch.idTokenSignedResponseAlg,
      scopes: patch.scopes === undefined ? current.scopes : patch.scopes,
      emailTrust: patch.emailTrust ?? current.emailTrust,
      claims:
        patch.claims === undefined ? current.claims : claimsOf(patch.claims),
      upstreamAcr:
        patch.upstreamMfa === undefined
          ? (current.upstreamMfa?.acr ?? null)
          : (patch.upstreamMfa?.acr ?? null),
    };
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
      await this.assertDomainsFree(tenantId, current, domains);
    }
    return this.scoped(tenantId).update(current._id, {
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
    const current = await this.get(tenantId, connectionId);
    checked(
      partsOf(
        current,
        clientSecret,
        current.domains.map((entry) => entry.domain),
      ),
    );
    return this.scoped(tenantId).update(current._id, {
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
    const scoped = this.scoped(tenantId);
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

  /** Removes a connection; refused while accounts are linked through it. */
  async delete(tenantId: string, connectionId: string): Promise<boolean> {
    const current = await this.find(tenantId, connectionId);
    if (current === undefined) return false;
    if ((await this.options.links(tenantId, connectionId)) > 0) {
      throw new ConnectionError(
        "CONNECTION_IN_USE",
        "Accounts are linked through this connection: switch it off instead",
      );
    }
    await this.scoped(tenantId).delete(current._id);
    return true;
  }

  /** A domain of `domains` that another enabled connection of the tenant already holds. */
  private async assertDomainsFree(
    tenantId: string,
    except: ConnectionDoc,
    domains: readonly string[],
  ) {
    if (domains.length === 0) return;
    const others = await this.scoped(tenantId).findMany({
      filter: { enabled: true, "domains.domain": { $in: [...domains] } },
    });
    if (others.some((other) => !other._id.equals(except._id))) {
      throw new ConnectionError(
        "DOMAIN_TAKEN",
        "A domain of this connection is already held by another enabled connection",
        "domains",
      );
    }
  }

  /** Claims a domain: normalised by janus, a TXT token minted, not verified yet. */
  async addDomain(
    tenantId: string,
    connectionId: string,
    domain: string,
  ): Promise<ConnectionDoc> {
    const current = await this.get(tenantId, connectionId);
    const normalised = checked({
      ...partsOf(current, this.openSecret(tenantId, current), [domain]),
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
    const held = await this.scoped(tenantId).findMany({
      filter: { "domains.domain": normalised },
    });
    if (held.length > 0) {
      throw new ConnectionError(
        "DOMAIN_TAKEN",
        "This domain is already on a connection of this tenant",
        "domain",
      );
    }
    return this.scoped(tenantId).update(current._id, {
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
    const current = await this.get(tenantId, connectionId);
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
    const connection = await this.scoped(tenantId).update(current._id, {
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
    const current = await this.get(tenantId, connectionId);
    if (!current.domains.some((entry) => entry.domain === domain)) {
      return current;
    }
    return this.scoped(tenantId).update(current._id, {
      domains: current.domains.filter((entry) => entry.domain !== domain),
      revision: current.revision + 1,
    });
  }

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
      await this.scoped(tenantId).findMany({
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
    const doc = await this.find(tenantId, connectionId);
    return doc?.enabled === true && doc.jit;
  }

  /** Specs only: answers the addresses of a host with no real DNS. Production leaves it unset. */
  useHostResolver(resolver: HostResolver | undefined): void {
    this.hostResolver = resolver;
  }

  /**
   * Specs only: replaces the transport of every request to an identity
   * provider (janus-social 0.10 otherwise connects to the checked addresses
   * itself, past the global `fetch`). Production leaves it unset.
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
        const doc = await this.find(tenantId, id);
        return doc === undefined ? null : this.build(tenantId, doc);
      },
      findConnectionByDomain: async (domain) => {
        const only = await this.ownerOf(tenantId, domain);
        return only === undefined ? null : this.build(tenantId, only);
      },
    };
  }

  private build(tenantId: string, doc: ConnectionDoc): OidcConnection | null {
    if (!doc.enabled) return null;
    const verified = doc.domains
      .filter((entry) => entry.verifiedAt !== null)
      .map((entry) => entry.domain);
    if (verified.length === 0) return null;
    try {
      return checked(partsOf(doc, this.openSecret(tenantId, doc), verified));
    } catch (error) {
      // The connection's id and the error's name only: a message could quote the record.
      this.log(
        `connections: ${doc.connectionId} of tenant ${tenantId} is off (${error instanceof Error ? error.name : "unknown error"})`,
      );
      return null;
    }
  }
}
