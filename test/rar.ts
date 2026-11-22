import { expect } from "bun:test";
import {
  createMemorySigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { z } from "zod";
import { exchangeRulesFor } from "@/config/client-policies";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { resourcesFor } from "@/config/resources";
import { tenantResolver } from "@/config/tenancy";
import { authFor, claimsFor } from "@/config/users";
import { mongoClientDetailTypes } from "@/modules/resources";
import { issuerOf } from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { type GqlResult, gqlOf } from "~/gql";
import { fieldOf } from "~/gql-field";
import { jsonOf, tokenBody } from "~/json";
import { parBody, recordBody } from "~/oauth-bodies";
import { quietOAuth } from "~/ports";

// M3b R4, end to end: authorization details (RFC 9396) from PAR to the
// tokens, through the hosted consent API (`oauthRequest.details`).
export const SLUG = "rar";
export const PAY = "https://pay.rar.example/api";
export const OTHER = "https://other.rar.example/api";
export const REDIRECT = "https://app.example/callback";
export const VERIFIER = "v".repeat(64);
export const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
export const keys = new Map<string, SigningKeyStore>();
export const signingKeysFor = (tenantId: string) => {
  let store = keys.get(tenantId);
  if (store === undefined) {
    store = createMemorySigningKeys();
    keys.set(tenantId, store);
  }
  return store;
};
export const issuers = createClavixOAuthIssuers({
  ...quietOAuth,
  clock: { now: () => new Date() },
  dpopNonceSecret: "spec-dpop-nonce-secret",
  resolver: tenantResolver,
  db: oauthDb,
  signingKeysFor,
  authFor,
  claimsFor,
  resourcesFor,
  exchangeRulesFor,
});
export const app = createTestApp({ oauth: issuers });
export const findTenant = (slug: string) =>
  mongo.db.tenants.findFirst({ slug });
export const ready = mongoClientDetailTypes(mongo.db.detailTypes);
export const text = (fr: string, en: string) => [
  { locale: "fr", text: fr },
  { locale: "en", text: en },
];

export const url = (path = "/") => `${issuerOf(SLUG, origin)}${path}`;
export const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${id}:${secret}`)}`;
export const secrets: Record<string, string> = {};
let cookie = "";
/** Signs the spec's requests in with a session token. */
export const signIn = (token: string) => {
  cookie = `${SESSION_COOKIE}=${token}`;
};

export const gql = async (
  query: string,
  variables: Record<string, unknown>,
  language?: string,
): Promise<GqlResult> => {
  const response = await app.request(url("/graphql"), {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      cookie,
      ...(language === undefined ? {} : { "accept-language": language }),
    },
    body: JSON.stringify({ query, variables }),
  });
  return gqlOf(response);
};

export const redirected = z.object({ redirectTo: z.string() });
export const withDetails = z.object({ details: z.array(z.unknown()) });
export const withComplete = z.object({ detailsComplete: z.boolean() });

export const DETAILS = `details { type title description rows { kind key label values { kind text number boolean } } }`;
export const REQUEST = `query($id: ID!) { oauthRequest(id: $id) { authorizationDetails ${DETAILS} } }`;
export const APPROVE = `mutation($id: ID!) { approveOAuthRequest(id: $id) { redirectTo } }`;
export const DEVICE = `query($c: String!) { oauthDeviceRequest(userCode: $c) { authorizationDetails ${DETAILS} } }`;
export const APPROVE_DEVICE = `mutation($c: String!) { approveOAuthDeviceRequest(userCode: $c) }`;

// A row as the API sends it: a stable kind and typed values, no word of its own.
export const value = (v: {
  text?: string;
  number?: number;
  boolean?: boolean;
}) => ({
  kind:
    v.number !== undefined
      ? "NUMBER"
      : v.boolean !== undefined
        ? "BOOLEAN"
        : "TEXT",
  text: null,
  number: null,
  boolean: null,
  ...v,
});
export const row = (
  kind: string,
  values: ReturnType<typeof value>[],
  field: { key: string; label: string } | null = null,
) => ({ kind, key: field?.key ?? null, label: field?.label ?? null, values });

export const transfer = (
  amount: number,
  extra: Record<string, unknown> = {},
) => ({
  type: "payment",
  actions: ["initiate"],
  amount,
  currency: "EUR",
  urgent: true,
  memo: "Rent",
  ...extra,
});

export const post = (
  path: string,
  body: Record<string, string>,
  client: string,
  headers: Record<string, string> = {},
) =>
  issuers.handle(
    new Request(url(path), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic(client, secrets[client] ?? ""),
        ...headers,
      },
      body: new URLSearchParams(body),
    }),
  );

export async function pushed(
  details: unknown,
  options: { client?: string; scope?: string; resource?: string } = {},
) {
  const { client = "payer", scope = "read", resource = PAY } = options;
  const response = await post(
    "/par",
    {
      response_type: "code",
      client_id: client,
      redirect_uri: REDIRECT,
      code_challenge: await s256Challenge(VERIFIER),
      code_challenge_method: "S256",
      scope,
      resource,
      state: "xyz",
      ...(details === null
        ? {}
        : { authorization_details: JSON.stringify(details) }),
    },
    client,
  );
  expect(response.status).toBe(201);
  const { request_uri } = await jsonOf(response, parBody);
  const authorize = await issuers.handle(
    new Request(
      url(
        `/authorize?${new URLSearchParams({ client_id: client, request_uri })}`,
      ),
    ),
  );
  expect(authorize.status).toBe(302);
  const location = new URL(authorize.headers.get("location") ?? "", url());
  return location.searchParams.get("request_id") ?? "";
}

export async function approve(id: string) {
  const approved = await gql(APPROVE, { id });
  expect(approved.errors).toBeUndefined();
  return fieldOf(approved, "approveOAuthRequest", redirected).redirectTo;
}

export const codeToken = (redirectTo: string, client = "payer") =>
  post(
    "/token",
    {
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: PAY,
    },
    client,
  );

export const tokensBody = tokenBody.extend({
  authorization_details: z.array(recordBody).optional(),
});
/** PAR with these details, consent, approval, code exchange. */
export async function consented(details: unknown, scope = "read") {
  const response = await codeToken(
    await approve(await pushed(details, { scope })),
  );
  expect(response.status).toBe(200);
  return jsonOf(response, tokensBody);
}

export const introspect = async (token: string) =>
  jsonOf(await post("/introspect", { token }, "payer"), recordBody);
