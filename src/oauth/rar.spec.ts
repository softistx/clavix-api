import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemorySigningKeys,
  DEVICE_GRANT,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  clientPoliciesService,
  exchangeRulesFor,
} from "@/config/client-policies";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import {
  registerStoredResource,
  resourcesFor,
  resourcesService,
} from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { authFor, claimsFor, janusIssuers } from "@/config/users";
import { registerClient } from "@/modules/clients";
import { mongoClientDetailTypes } from "@/modules/resources";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { type GqlResult, gqlOf } from "~/gql";
import { fieldOf } from "~/gql-field";
import { errorBody, jsonOf, tokenBody } from "~/json";
import { deviceCodesBody, parBody, recordBody } from "~/oauth-bodies";
import { quietOAuth } from "~/ports";
import { createTenantParOff } from "~/tenant-par-off";

// M3b R4, end to end: authorization details (RFC 9396) from PAR to the
// tokens, through the hosted consent API (`oauthRequest.details`).
const SLUG = "rar";
const PAY = "https://pay.rar.example/api";
const OTHER = "https://other.rar.example/api";
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;
const keys = new Map<string, SigningKeyStore>();
const signingKeysFor = (tenantId: string) => {
  let store = keys.get(tenantId);
  if (store === undefined) {
    store = createMemorySigningKeys();
    keys.set(tenantId, store);
  }
  return store;
};
const issuers = createClavixOAuthIssuers({
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
const app = createTestApp({ oauth: issuers });
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const ready = mongoClientDetailTypes(mongo.db.detailTypes);
const text = (fr: string, en: string) => [
  { locale: "fr", text: fr },
  { locale: "en", text: en },
];

const url = (path = "/") => `${issuerOf(SLUG, origin)}${path}`;
const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${id}:${secret}`)}`;
const secrets: Record<string, string> = {};
let cookie = "";

const gql = async (
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

const redirected = z.object({ redirectTo: z.string() });
const withDetails = z.object({ details: z.array(z.unknown()) });
const withComplete = z.object({ detailsComplete: z.boolean() });

const DETAILS = `details { type title description rows { label value } }`;
const REQUEST = `query($id: ID!) { oauthRequest(id: $id) { authorizationDetails ${DETAILS} } }`;
const APPROVE = `mutation($id: ID!) { approveOAuthRequest(id: $id) { redirectTo } }`;
const DEVICE = `query($c: String!) { oauthDeviceRequest(userCode: $c) { authorizationDetails ${DETAILS} } }`;
const APPROVE_DEVICE = `mutation($c: String!) { approveOAuthDeviceRequest(userCode: $c) }`;

const transfer = (amount: number, extra: Record<string, unknown> = {}) => ({
  type: "payment",
  actions: ["initiate"],
  amount,
  currency: "EUR",
  urgent: true,
  memo: "Rent",
  ...extra,
});

const post = (
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

async function pushed(
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

async function approve(id: string) {
  const approved = await gql(APPROVE, { id });
  expect(approved.errors).toBeUndefined();
  return fieldOf(approved, "approveOAuthRequest", redirected).redirectTo;
}

const codeToken = (redirectTo: string, client = "payer") =>
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

const tokensBody = tokenBody.extend({
  authorization_details: z.array(recordBody).optional(),
});
/** PAR with these details, consent, approval, code exchange. */
async function consented(details: unknown, scope = "read") {
  const response = await codeToken(
    await approve(await pushed(details, { scope })),
  );
  expect(response.status).toBe(200);
  return jsonOf(response, tokensBody);
}

const introspect = async (token: string) =>
  jsonOf(await post("/introspect", { token }, "payer"), recordBody);

beforeAll(async () => {
  await createTenantParOff(tenantsService, { slug: SLUG, name: SLUG });
  const tenant = await findTenant(SLUG);
  const resolved = await tenantResolver.resolveHost(new URL(url()).host);
  if (tenant === undefined || resolved === null) throw new Error("no tenant");
  await rotateSigningKeys(signingKeysFor(resolved.tenantId), {
    now: new Date(),
    lead: "1h",
    retireAfter: "2h",
  });
  for (const uri of [PAY, OTHER]) {
    await registerStoredResource({ tenant: SLUG, uri, scopes: ["read"] });
  }
  const pay = await mongo.db.resources.findFirst({
    uri: PAY,
    tenantId: tenant._id,
  });
  if (pay === undefined) throw new Error("no resource");
  await resourcesService.createDetailType(tenant._id, pay._id.toHexString(), {
    type: "payment",
    name: text("Paiement", "Payment"),
    description: text("Initier des virements", "Start transfers"),
    actions: [
      { value: "initiate", label: text("Initier", "Initiate") },
      { value: "cancel", label: text("Annuler", "Cancel") },
    ],
    fields: [
      { key: "amount", kind: "number", label: text("Montant", "Amount") },
      {
        key: "currency",
        kind: "enum",
        label: text("Devise", "Currency"),
        values: [{ value: "EUR", label: text("Euro", "Euro") }],
      },
      { key: "urgent", kind: "boolean", label: text("Urgent", "Urgent") },
      { key: "memo", kind: "string", label: text("Motif", "Memo") },
    ],
  });
  const register = async (
    clientId: string,
    input: Partial<Parameters<typeof registerClient>[1]>,
  ) => {
    const done = await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant, detailTypes: ready },
      {
        tenant: SLUG,
        name: clientId,
        clientId,
        redirectUris: [],
        type: "confidential",
        requirePar: true,
        ...input,
      },
    );
    secrets[clientId] = done.clientSecret ?? "";
  };
  await register("payer", {
    redirectUris: [REDIRECT],
    detailTypes: ["payment"],
  });
  await register("tv", { grants: [DEVICE_GRANT], detailTypes: ["payment"] });
  await register("svc", { grants: [TOKEN_EXCHANGE_GRANT] });
  await clientPoliciesService.setTokenExchange(tenant._id, "svc", {
    targetResources: [PAY, OTHER],
    subjectClients: ["payer"],
    subjectAgents: false,
    mode: "delegation",
  });
  const auth = await janusIssuers.forRequest(new Request(url()));
  if (auth === null) throw new Error("no janus");
  const user = await auth.create({ email: "ada@example.test" });
  const session = await auth.signInProven(user);
  if (session.status !== "signedIn") throw new Error("no session");
  cookie = `${SESSION_COOKIE}=${session.token}`;
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
  await oauthDb.collection("partitionedUsers").deleteMany({});
  await oauthDb.collection("partitionedSessions").deleteMany({});
});

describe("authorization details through consent", () => {
  test("PAR with details, consent view, approval: the token answer, the JWT and introspection carry them", async () => {
    const asked = [transfer(10), transfer(20, { memo: "Deposit" })];
    const id = await pushed(asked);
    const view = await gql(REQUEST, { id });
    expect(view.errors).toBeUndefined();
    const request = fieldOf(
      view,
      "oauthRequest",
      z.object({
        authorizationDetails: z.string(),
        details: z.array(z.unknown()),
      }),
    );
    // Every detail reaches the hosted API, in words, none raw.
    expect(request.details).toHaveLength(2);
    expect(JSON.parse(request.authorizationDetails)).toHaveLength(2);

    const tokens = await jsonOf(await codeToken(await approve(id)), tokensBody);
    expect(tokens.authorization_details).toEqual(asked);
    expect(decodeJwt(tokens.access_token)["authorization_details"]).toEqual(
      asked,
    );
    const active = await introspect(tokens.access_token);
    expect(active["active"]).toBe(true);
    expect(active["authorization_details"]).toEqual(asked);
  });

  test("a request without details has an empty list", async () => {
    const id = await pushed(null);
    const view = await gql(REQUEST, { id });
    expect(view.errors).toBeUndefined();
    expect(view.data?.["oauthRequest"]).toMatchObject({
      authorizationDetails: null,
      details: [],
    });
  });

  test("the labels follow the viewer's language, then the other one", async () => {
    const id = await pushed([transfer(1500.5)]);
    const detailsIn = async (language?: string) => {
      const view = await gql(REQUEST, { id }, language);
      expect(view.errors).toBeUndefined();
      return fieldOf(view, "oauthRequest", withDetails).details;
    };
    expect(await detailsIn("fr-CA,en;q=0.8")).toEqual([
      {
        type: "payment",
        title: "Paiement",
        description: "Initier des virements",
        rows: [
          { label: "Actions", value: "Initier" },
          {
            label: "Montant",
            value: new Intl.NumberFormat("fr-CA").format(1500.5),
          },
          { label: "Devise", value: "Euro" },
          { label: "Urgent", value: "Oui" },
          { label: "Motif", value: "Rent" },
        ],
      },
    ]);
    expect(await detailsIn("en-US")).toEqual([
      {
        type: "payment",
        title: "Payment",
        description: "Start transfers",
        rows: [
          { label: "Actions", value: "Initiate" },
          { label: "Amount", value: "1,500.5" },
          { label: "Currency", value: "Euro" },
          { label: "Urgent", value: "Yes" },
          { label: "Memo", value: "Rent" },
        ],
      },
    ]);
  });

  test("a type the tenant wrote no French for shows its English words", async () => {
    const tenant = await findTenant(SLUG);
    if (tenant === undefined) throw new Error("no tenant");
    const resource = await mongo.db.resources.findFirst({
      uri: PAY,
      tenantId: tenant._id,
    });
    if (resource === undefined) throw new Error("none");
    await resourcesService.createDetailType(
      tenant._id,
      resource._id.toHexString(),
      {
        type: "ledger",
        name: text("", "Ledger"),
        fields: [
          { key: "account", kind: "string", label: text("", "Account") },
        ],
      },
    );
    await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant, detailTypes: ready },
      {
        tenant: SLUG,
        name: "payer",
        clientId: "payer",
        redirectUris: [REDIRECT],
        type: "confidential",
        requirePar: true,
        detailTypes: ["payment", "ledger"],
      },
    );
    const id = await pushed([{ type: "ledger", account: "A-1" }]);
    const view = await gql(REQUEST, { id }, "fr");
    expect(fieldOf(view, "oauthRequest", withDetails).details).toEqual([
      {
        type: "ledger",
        title: "Ledger",
        description: "",
        rows: [{ label: "Account", value: "A-1" }],
      },
    ]);
  });
});

describe("what happens to the details after consent", () => {
  test("a refresh narrows them, never widens", async () => {
    const first = transfer(10);
    const second = transfer(20, { memo: "Deposit" });
    const tokens = await consented([first, second], "read");
    const refreshed = await post(
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        resource: PAY,
        authorization_details: JSON.stringify([first]),
      },
      "payer",
    );
    expect(refreshed.status).toBe(200);
    const narrowed = await jsonOf(refreshed, tokensBody);
    expect(narrowed.authorization_details).toEqual([first]);
    expect(decodeJwt(narrowed.access_token)["authorization_details"]).toEqual([
      first,
    ]);

    // The grant keeps what the user allowed: a detail they never saw is refused.
    const widened = await post(
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: narrowed.refresh_token ?? "",
        resource: PAY,
        authorization_details: JSON.stringify([transfer(99)]),
      },
      "payer",
    );
    expect(widened.status).toBe(400);
    expect((await jsonOf(widened, errorBody)).error).toBe(
      "invalid_authorization_details",
    );
  });

  test("a re-consent that leaves a detail out revokes the grant's tokens, one that asks for none revokes nothing", async () => {
    const kept = transfer(10);
    const before = await consented([kept, transfer(20, { memo: "Deposit" })]);
    expect((await introspect(before.access_token))["active"]).toBe(true);
    // No detail: the standing grant stays (janus-oauth, "Consent").
    const plain = await consented(null);
    expect(plain.authorization_details).toBeUndefined();
    expect((await introspect(before.access_token))["active"]).toBe(true);
    // The grant's details are replaced; leaving one out revokes its tokens.
    const after = await consented([kept]);
    expect(after.authorization_details).toEqual([kept]);
    expect((await introspect(before.access_token))["active"]).toBe(false);
    expect((await introspect(after.access_token))["active"]).toBe(true);
  });

  test("a token exchange inherits the details on the same resource and drops them on another", async () => {
    const asked = [transfer(10)];
    const { access_token } = await consented(asked);
    const exchange = (resource: string) =>
      post(
        "/token",
        {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: access_token,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource,
        },
        "svc",
      );
    const same = await exchange(PAY);
    expect(same.status).toBe(200);
    expect(
      decodeJwt((await jsonOf(same, tokensBody)).access_token)[
        "authorization_details"
      ],
    ).toEqual(asked);
    const other = await exchange(OTHER);
    expect(other.status).toBe(200);
    expect(
      decodeJwt((await jsonOf(other, tokensBody)).access_token)[
        "authorization_details"
      ],
    ).toBeUndefined();
  });
});

describe("the device flow", () => {
  test("the verification page shows the details, approval allows all, the token carries them", async () => {
    const asked = [transfer(10)];
    const response = await post(
      "/device_authorization",
      {
        client_id: "tv",
        scope: "read",
        resource: PAY,
        authorization_details: JSON.stringify(asked),
      },
      "tv",
    );
    expect(response.status).toBe(200);
    const codes = await jsonOf(response, deviceCodesBody);
    const view = await gql(DEVICE, { c: codes.user_code }, "fr");
    expect(view.errors).toBeUndefined();
    const shown = fieldOf(view, "oauthDeviceRequest", withDetails).details;
    expect(shown).toMatchObject([
      {
        type: "payment",
        title: "Paiement",
        description: "Initier des virements",
      },
    ]);
    expect(shown).toHaveLength(1);

    const approved = await gql(APPROVE_DEVICE, { c: codes.user_code });
    expect(approved.errors).toBeUndefined();
    const tokens = await post(
      "/token",
      {
        grant_type: DEVICE_GRANT,
        device_code: codes.device_code,
        client_id: "tv",
      },
      "tv",
    );
    expect(tokens.status).toBe(200);
    const body = await jsonOf(tokens, tokensBody);
    expect(body.authorization_details).toEqual(asked);
    expect(decodeJwt(body.access_token)["authorization_details"]).toEqual(
      asked,
    );
  });
});

// Review follow-up (R4, D4): approval allows only what the page could show.
describe("details the page cannot fully describe", () => {
  const DEVICE_VIEW = `query($c: String!) { oauthDeviceRequest(userCode: $c) { detailsComplete } }`;
  const VIEW = `query($id: ID!) { oauthRequest(id: $id) { detailsComplete details { type } } }`;
  const asked = { type: "gift", note: "Hello", tag: "a" };
  let giftId = "";
  const gifted = (type: string) => ({ ...asked, type });

  // A fresh "gift" type per test, so each one edits or deletes its own.
  async function createGift(type = "gift") {
    const tenant = await findTenant(SLUG);
    if (tenant === undefined) throw new Error("no tenant");
    const resource = await mongo.db.resources.findFirst({
      uri: PAY,
      tenantId: tenant._id,
    });
    if (resource === undefined) throw new Error("none");
    const created = await resourcesService.createDetailType(
      tenant._id,
      resource._id.toHexString(),
      {
        type,
        name: text("Cadeau", "Gift"),
        fields: [
          { key: "note", kind: "string", label: text("Note", "Note") },
          { key: "tag", kind: "string", label: text("Etiquette", "Tag") },
        ],
      },
    );
    giftId = created._id.toHexString();
    await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant, detailTypes: ready },
      {
        tenant: SLUG,
        name: "gifter",
        clientId: "gifter",
        redirectUris: [REDIRECT],
        type: "confidential",
        requirePar: true,
        grants: ["authorization_code", DEVICE_GRANT],
        detailTypes: [type],
      },
    ).then((done) => {
      secrets["gifter"] = done.clientSecret ?? secrets["gifter"] ?? "";
    });
    return tenant._id;
  }
  const dropGift = (type: string) =>
    mongo.db.detailTypes.raw.deleteMany({ type });

  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions?.code;
  const deviceCode = async (details: unknown) => {
    const response = await post(
      "/device_authorization",
      {
        client_id: "gifter",
        scope: "read",
        resource: PAY,
        authorization_details: JSON.stringify(details),
      },
      "gifter",
    );
    expect(response.status).toBe(200);
    return jsonOf(response, deviceCodesBody);
  };

  test("unchanged: complete and approved", async () => {
    await createGift("gift-ok");
    const id = await pushed([gifted("gift-ok")], { client: "gifter" });
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", z.unknown())).toEqual({
      detailsComplete: true,
      details: [{ type: "gift-ok" }],
    });
    const approved = await gql(APPROVE, { id });
    expect(approved.errors).toBeUndefined();
    const codes = await deviceCode([gifted("gift-ok")]);
    const seen = await gql(DEVICE_VIEW, { c: codes.user_code });
    expect(
      fieldOf(seen, "oauthDeviceRequest", withComplete).detailsComplete,
    ).toBe(true);
    expect((await gql(APPROVE_DEVICE, { c: codes.user_code })).errors).toBe(
      undefined,
    );
    await dropGift("gift-ok");
  });

  test("a selection of details is refused in both flows (D4: all or nothing), the request stays pending", async () => {
    await createGift("gift-sel");
    const id = await pushed([gifted("gift-sel")], { client: "gifter" });
    const codes = await deviceCode([gifted("gift-sel")]);
    const selection = JSON.stringify([gifted("gift-sel")]);
    const refused = await gql(
      `mutation($id: ID!, $d: String) { approveOAuthRequest(id: $id, authorizationDetails: $d) { redirectTo } }`,
      { id, d: selection },
    );
    expect(codeOf(refused)).toBe("BAD_USER_INPUT");
    expect(refused.errors?.[0]?.message).toBe("invalid_authorization_details");
    const device = await gql(
      `mutation($c: String!, $d: String) { approveOAuthDeviceRequest(userCode: $c, authorizationDetails: $d) }`,
      { c: codes.user_code, d: selection },
    );
    expect(codeOf(device)).toBe("BAD_USER_INPUT");
    expect(device.errors?.[0]?.message).toBe("invalid_authorization_details");
    // Still pending: approving without a selection works.
    expect((await gql(APPROVE, { id })).errors).toBeUndefined();
    await dropGift("gift-sel");
  });

  test("a field removed between the PAR and the consent: not complete, approval refused, request still pending", async () => {
    const tenantId = await createGift("gift-edit");
    const id = await pushed([gifted("gift-edit")], { client: "gifter" });
    const codes = await deviceCode([gifted("gift-edit")]);
    await resourcesService.updateDetailType(tenantId, giftId, {
      fields: [{ key: "note", kind: "string", label: text("Note", "Note") }],
    });
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", withComplete).detailsComplete).toBe(
      false,
    );
    const refused = await gql(APPROVE, { id });
    expect(codeOf(refused)).toBe("BAD_USER_INPUT");
    expect(refused.errors?.[0]?.message).toBe("invalid_authorization_details");
    const seen = await gql(DEVICE_VIEW, { c: codes.user_code });
    expect(
      fieldOf(seen, "oauthDeviceRequest", withComplete).detailsComplete,
    ).toBe(false);
    const device = await gql(APPROVE_DEVICE, { c: codes.user_code });
    expect(device.errors?.[0]?.message).toBe("invalid_authorization_details");
    // Nothing was approved: denying still works.
    const denied = await gql(
      `mutation($id: ID!) { denyOAuthRequest(id: $id) { redirectTo } }`,
      { id },
    );
    expect(denied.errors).toBeUndefined();
    await dropGift("gift-edit");
  });

  test("a type deleted between the PAR and the consent: not complete, approval refused", async () => {
    await createGift("gift-gone");
    const id = await pushed([gifted("gift-gone")], { client: "gifter" });
    const codes = await deviceCode([gifted("gift-gone")]);
    await dropGift("gift-gone");
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", withComplete).detailsComplete).toBe(
      false,
    );
    expect(codeOf(await gql(APPROVE, { id }))).toBe("BAD_USER_INPUT");
    expect(codeOf(await gql(APPROVE_DEVICE, { c: codes.user_code }))).toBe(
      "BAD_USER_INPUT",
    );
  });

  test("a request without details is complete", async () => {
    const id = await pushed(null);
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", withComplete).detailsComplete).toBe(
      true,
    );
  });
});
