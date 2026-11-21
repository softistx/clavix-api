import type { OAuthClientRecord } from "@softistx/janus-oauth";
import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import type { TokenExchangeRules } from "@/modules/client-policies/client-policies.model";
import type { CliTenant } from "@/shared/cli";
import { DEFAULT_GRANTS } from "./clients.rules";
import type {
  AgentKinds,
  AgentKindsOf,
  AgentsReader,
  ClientRegistration,
  ClientSettingsInput,
  ClientView,
  SentSettings,
} from "./clients.types";

// What an admin event names: the client's id and its tenant, never its secret.
export const target = (
  tenant: { _id: { toHexString(): string } },
  id: string,
) => ({
  type: "client",
  // The trail holds 200 characters: a metadata-document client's id is a URL.
  id: id.slice(0, 200),
  tenantId: tenant._id.toHexString(),
});

const TYPE = { public: "PUBLIC", confidential: "CONFIDENTIAL" } as const;

const GRANT = {
  authorization_code: "AUTHORIZATION_CODE",
  refresh_token: "REFRESH_TOKEN",
  [DEVICE_GRANT]: "DEVICE_CODE",
  [TOKEN_EXCHANGE_GRANT]: "TOKEN_EXCHANGE",
  [CLIENT_CREDENTIALS_GRANT]: "CLIENT_CREDENTIALS",
} as const;

const REGISTRATION = {
  console: "CONSOLE",
  dynamic: "DYNAMIC",
  metadata: "METADATA",
} as const;

/** The registrations of the enum list a call sent, as the service names them; `undefined` for none. */
export const kindsOf = (
  kinds: readonly (keyof typeof KIND)[] | null | undefined,
) => kinds?.map((kind) => KIND[kind]);

const KIND = {
  CONSOLE: "console",
  DYNAMIC: "dynamic",
  METADATA: "metadata",
} as const;

const WIRE_GRANT = {
  AUTHORIZATION_CODE: "authorization_code",
  REFRESH_TOKEN: "refresh_token",
  DEVICE_CODE: DEVICE_GRANT,
  TOKEN_EXCHANGE: TOKEN_EXCHANGE_GRANT,
  CLIENT_CREDENTIALS: CLIENT_CREDENTIALS_GRANT,
} as const;

export type Rules = TokenExchangeRules | null;

const exchangeShape = (rules: Rules | undefined) =>
  rules === null || rules === undefined
    ? null
    : {
        targetResources: [...rules.targetResources],
        subjectClients:
          rules.subjectClients === "any" ? [] : [...rules.subjectClients],
        anySubjectClient: rules.subjectClients === "any",
        subjectAgents: rules.subjectAgents === true,
        mode: "DELEGATION" as const,
      };

export const shape = (
  client: {
    clientId: string;
    name: string;
    type: "public" | "confidential";
    redirectUris: readonly string[];
    grantTypes: readonly string[];
    createdAt: Date;
    requirePushedAuthorizationRequests: boolean;
    dpopBoundAccessTokens: boolean;
    registration: "console" | "dynamic" | "metadata";
    authorizationDetailsTypes: readonly string[];
    allowedScopes: readonly string[];
    defaultScopes: readonly string[];
  },
  rules?: Rules,
) => ({
  id: client.clientId,
  name: client.name,
  type: TYPE[client.type],
  redirectUris: [...client.redirectUris],
  grantTypes: client.grantTypes.flatMap((grant) =>
    Object.hasOwn(GRANT, grant) ? [GRANT[grant as keyof typeof GRANT]] : [],
  ),
  createdAt: client.createdAt,
  requirePushedAuthorizationRequests: client.requirePushedAuthorizationRequests,
  dpopBoundAccessTokens: client.dpopBoundAccessTokens,
  authorizationDetailsTypes: [...client.authorizationDetailsTypes],
  allowedScopes: [...client.allowedScopes],
  defaultScopes: [...client.defaultScopes],
  tokenExchange: exchangeShape(rules),
  registration: REGISTRATION[client.registration],
});

/** The wire grants of the enum list a call sent; `undefined` when it sent none (keep or default). */
export const grantsOf = (
  grants: readonly (keyof typeof WIRE_GRANT)[] | null | undefined,
) => grants?.map((grant) => WIRE_GRANT[grant]);

/** The `Exclusive` key of a tenant's client writes (create, update, rotate, delete). */
export const clientsKey = (tenant: { _id: { toHexString(): string } }) =>
  `console:clients:${tenant._id.toHexString()}`;

const CLIENT_ID = /^[a-z0-9-]{1,64}$/;

/** Whether an id could be a client's: anything else names nothing to record on the trail. */
export const isClientId = (id: string) => CLIENT_ID.test(id);

type ClientInput = {
  name?: string | null;
  redirectUris?: readonly string[] | null;
  grantTypes?: readonly (keyof typeof WIRE_GRANT)[] | null;
  requirePushedAuthorizationRequests?: boolean | null;
  dpopBoundAccessTokens?: boolean | null;
  authorizationDetailsTypes?: readonly string[] | null;
  allowedScopes?: readonly string[] | null;
  defaultScopes?: readonly string[] | null;
};

/** The settings a create or an update call sent, as the service names them; an omitted one stays `undefined` (keep or default). */
export const settingsOf = (input: ClientInput) => ({
  grants: grantsOf(input.grantTypes),
  requirePar: input.requirePushedAuthorizationRequests ?? undefined,
  dpopBound: input.dpopBoundAccessTokens ?? undefined,
  detailTypes: input.authorizationDetailsTypes ?? undefined,
  allowedScopes: input.allowedScopes ?? undefined,
  defaultScopes: input.defaultScopes ?? undefined,
});

/** A capability the janus port leaves optional; the Mongo store has them all. */
export function capability<T>(method: T | undefined, name: string): T {
  if (method === undefined) {
    throw new Error(`the OAuth store has no ${name}()`);
  }
  return method;
}

/** How a janus record was registered: a metadata document is one, a registered client the agents store knows is dynamic. */
export const registrationOf = (
  record: OAuthClientRecord,
  agents: AgentKinds = new Map(),
): ClientRegistration =>
  record.source === "metadata"
    ? "metadata"
    : (agents.get(record.id) ?? "console");

/** A janus record as the console shows it, without its secret hash. */
export const viewOf = (
  record: OAuthClientRecord,
  agents?: AgentKinds,
): ClientView => ({
  clientId: record.id,
  name: record.name,
  type: record.secretHash === undefined ? "public" : "confidential",
  redirectUris: record.redirectUris,
  grantTypes: record.grantTypes ?? DEFAULT_GRANTS,
  createdAt: record.createdAt,
  requirePushedAuthorizationRequests:
    record.requirePushedAuthorizationRequests === true,
  dpopBoundAccessTokens: record.dpopBoundAccessTokens === true,
  registration: registrationOf(record, agents),
  authorizationDetailsTypes: record.authorizationDetailsTypes ?? [],
  allowedScopes: record.allowedScopes ?? [],
  defaultScopes: record.defaultScopes ?? [],
});

/** Reads the tenant's agents among some client ids (bounded by them). */
export const agentKindsOf =
  (agents: AgentsReader, tenant: CliTenant): AgentKindsOf =>
  async (clientIds): Promise<AgentKinds> =>
    await agents.kinds(tenant._id.toHexString(), clientIds);

/**
 * The settings a create or an update call sent, without the omitted ones:
 * spread into a registration, so an omitted setting stays as recorded (or
 * defaulted) and is never sent as `undefined`.
 */
export const sentSettings = (input: ClientSettingsInput): SentSettings => {
  const { requirePar, dpopBound, grants, detailTypes } = input;
  const { allowedScopes, defaultScopes } = input;
  const sent = {
    requirePar,
    dpopBound,
    grants,
    detailTypes,
    allowedScopes,
    defaultScopes,
  };
  return Object.fromEntries(
    Object.entries(sent).filter(([, value]) => value !== undefined),
  ) as SentSettings;
};
