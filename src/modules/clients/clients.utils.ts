import {
  CLIENT_CREDENTIALS_GRANT,
  DEVICE_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import type { clientsService } from "@/config/clients";

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

export type Rules = Awaited<ReturnType<typeof clientsService.tokenExchange>>;

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
