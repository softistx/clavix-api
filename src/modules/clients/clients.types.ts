import type {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  OAuthClientGrantType,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import type { Db } from "mongodb";
import type { AgentsService } from "@/modules/agents";
import type { AgentKind } from "@/modules/agents/agents.model";
import type { ClientPoliciesService } from "@/modules/client-policies/client-policies.service";
import type { ClientDetailTypes } from "@/modules/resources";
import type { CliTenant } from "@/shared/cli";

/** The grant types Clavix offers (the list is `OFFERED_GRANTS`, in the rules). */
export type OfferedGrant =
  | "authorization_code"
  | "refresh_token"
  | typeof DEVICE_GRANT
  | typeof TOKEN_EXCHANGE_GRANT
  | typeof CLIENT_CREDENTIALS_GRANT;

/**
 * How a client came to exist: `console` (registered by an admin or a script),
 * `dynamic` (it registered itself, RFC 7591) or `metadata` (a Client ID
 * Metadata Document describes it). The last two are the tenant's agents.
 */
export type ClientRegistration = "console" | AgentKind;

/** The tenant's recorded agents by client id (`AgentClientsPort.kinds`). */
export type AgentKinds = ReadonlyMap<string, AgentKind>;

/** Reads the recorded agents among these client ids (`AgentClientsPort.kinds` with ids): one bounded read per page. */
export type AgentKindsOf = (
  clientIds: readonly string[],
) => Promise<AgentKinds>;

/** The part of the agents store the clients service reads. */
export type AgentsReader = Pick<AgentsService, "kinds" | "remove">;

/** A client as the console shows it: a janus record without its secret hash. */
export interface ClientView {
  clientId: string;
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
  /** As recorded on the client (`authorization_code` and `refresh_token` when nothing is), enforced by janus. */
  grantTypes: readonly OAuthClientGrantType[];
  createdAt: Date;
  /** Whether the client must push its authorization requests to `/par` (RFC 9126). */
  requirePushedAuthorizationRequests: boolean;
  /** Whether the client's token requests must carry a DPoP proof (RFC 9449). */
  dpopBoundAccessTokens: boolean;
  /** How the client was registered; an agent is `dynamic` or `metadata`. */
  registration: ClientRegistration;
  /** The authorization detail types (RFC 9396) the client may ask for; empty when it lists none. */
  authorizationDetailsTypes: readonly string[];
  /** The scopes the client may ask for with `client_credentials` (the ceiling); empty without that grant. */
  allowedScopes: readonly string[];
  /** The scopes a `client_credentials` request with no `scope` gets. */
  defaultScopes: readonly string[];
}

/** Which clients a listing keeps, beyond `q`. */
export interface ClientFilter {
  /** Reads the tenant's agents among a page's ids. */
  agents: AgentKindsOf;
  /** Only these registrations; none or an empty list: every one. */
  kinds?: readonly ClientRegistration[] | undefined;
}

export interface ClientsServiceOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  /** The clients' per-client rules, removed with the client. */
  policies: ClientPoliciesService;
  /**
   * The tenant's agents: they are told apart in the listing, and a deleted
   * client stops being one (it frees the `agents` quota).
   */
  agents: AgentsReader;
  /** The tenants' detail types a client may list (R3). */
  detailTypes: ClientDetailTypes;
  now: () => Date;
}

/** The optional settings of a client a call may send; an omitted one is kept (update) or defaulted (create). */
export interface ClientSettingsInput {
  requirePar?: boolean | undefined;
  dpopBound?: boolean | undefined;
  /** The detail types the client may ask for (each a tenant type; needs `requirePar`). Default: none. */
  detailTypes?: readonly string[] | undefined;
  /** Default: `authorization_code` and `refresh_token`. */
  grants?: readonly string[] | undefined;
  /** The `client_credentials` scope ceiling (needs that grant, and a confidential client). */
  allowedScopes?: readonly string[] | undefined;
  /** The `client_credentials` default scopes, within `allowedScopes`. */
  defaultScopes?: readonly string[] | undefined;
}

/** The settings a call sent: an omitted one is absent, never `undefined`. */
export type SentSettings = {
  [K in keyof ClientSettingsInput]?: Exclude<ClientSettingsInput[K], undefined>;
};

export interface CreateClientInput extends ClientSettingsInput {
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
  clientId?: string | undefined;
}

export interface UpdateClientInput extends ClientSettingsInput {
  name?: string | undefined;
  redirectUris?: readonly string[] | undefined;
}

export interface TokenExchangeInput {
  targetResources: readonly string[];
  subjectClients: readonly string[] | "any";
  subjectAgents?: boolean;
}

export interface ClientListOptions {
  after?: string | null;
  limit: number;
  q?: string | undefined;
  kinds?: readonly ClientRegistration[] | undefined;
}

export interface RegisterClientInput {
  /** The tenant's slug. */
  tenant: string;
  name: string;
  redirectUris: readonly string[];
  /** `confidential` mints a secret (`client_secret_basic`); default `public` (PKCE only). */
  type?: "public" | "confidential";
  /**
   * The client's id inside the tenant, and the key of idempotency. Default: the
   * name, lowercased, as `a-z0-9-`. Re-running with the same id updates the client.
   */
  clientId?: string;
  /**
   * The grants the client may use, enforced by janus. Default: what the
   * client already records, else `authorization_code` and `refresh_token`.
   * A list must name `authorization_code`, the device grant or the token
   * exchange grant (add `refresh_token` for a client that refreshes); anything
   * else is refused. The token exchange grant needs a confidential client.
   * A client with no `authorization_code` needs no redirect URI.
   */
  grants?: readonly string[];
  /** Mint a new secret for an existing confidential client. */
  rotateSecret?: boolean;
  /**
   * Make this client push its authorization requests to `/par` (RFC 9126), on
   * a tenant that does not require it of everyone. Default: what the client
   * already records, else `false`.
   */
  requirePar?: boolean;
  /**
   * Bind this client's tokens to a DPoP key (RFC 9449): its token requests must
   * carry a proof, whatever the tenant requires. Default: what the client
   * already records, else `false`.
   */
  dpopBound?: boolean;
  /**
   * The authorization detail types (RFC 9396) the client may ask for: each is a
   * type of the tenant, and the client must push its requests (`requirePar`).
   * Replaces the list; `[]` clears it. Default: what the client already
   * records, else none.
   */
  detailTypes?: readonly string[];
  /**
   * The scopes the client may ask for with the client credentials grant (the
   * ceiling: a request is cut to them). Needs that grant; replaces the list.
   * Default: what the client already records. A client with the grant needs
   * at least one.
   */
  allowedScopes?: readonly string[];
  /**
   * The scopes a client credentials request with no `scope` gets, within
   * `allowedScopes`. Default: what the client already records, else none.
   */
  defaultScopes?: readonly string[];
}

export interface RegisteredClient {
  /** `true` when the client did not exist before. */
  created: boolean;
  tenant: string;
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  type: "public" | "confidential";
  /** The plain secret, shown here once; `null` for a public client or an unchanged secret. */
  clientSecret: string | null;
  /** Whether the client must push its authorization requests. */
  requirePar: boolean;
  /** Whether the client's token requests must carry a DPoP proof. */
  dpopBound: boolean;
  /** The detail types the client may ask for. */
  detailTypes: readonly string[];
  /** The client credentials scope ceiling; empty without that grant. */
  allowedScopes: readonly string[];
  /** The client credentials default scopes; empty without that grant. */
  defaultScopes: readonly string[];
}

export interface RegisterClientOptions {
  /** The plain driver `Db` of the janus OAuth collections (`oauthDb`). */
  db: Db;
  findTenant: (slug: string) => Promise<CliTenant | undefined>;
  now: () => Date;
  /** The tenant's detail types. */
  detailTypes: ClientDetailTypes;
}
