import { DEVICE_GRANT, TOKEN_EXCHANGE_GRANT } from "@softistx/janus-oauth";
import type { clientsService } from "@/config/clients";

// What an admin event names: the client's id and its tenant, never its secret.
export const target = (
  tenant: { _id: { toHexString(): string } },
  id: string,
) => ({
  type: "client",
  id,
  tenantId: tenant._id.toHexString(),
});

const TYPE = { public: "PUBLIC", confidential: "CONFIDENTIAL" } as const;

const GRANT = {
  authorization_code: "AUTHORIZATION_CODE",
  refresh_token: "REFRESH_TOKEN",
  [DEVICE_GRANT]: "DEVICE_CODE",
  [TOKEN_EXCHANGE_GRANT]: "TOKEN_EXCHANGE",
} as const;

const WIRE_GRANT = {
  AUTHORIZATION_CODE: "authorization_code",
  REFRESH_TOKEN: "refresh_token",
  DEVICE_CODE: DEVICE_GRANT,
  TOKEN_EXCHANGE: TOKEN_EXCHANGE_GRANT,
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
  tokenExchange: exchangeShape(rules),
});

/** The wire grants of the enum list a call sent; `undefined` when it sent none (keep or default). */
export const grantsOf = (
  grants: readonly (keyof typeof WIRE_GRANT)[] | null | undefined,
) => grants?.map((grant) => WIRE_GRANT[grant]);

/** The `Exclusive` key of a tenant's client writes (create, update, rotate, delete). */
export const clientsKey = (tenant: { _id: { toHexString(): string } }) =>
  `console:clients:${tenant._id.toHexString()}`;
