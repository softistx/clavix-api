import { expect } from "bun:test";
import {
  createMemorySigningKeys,
  rotateSigningKeys,
  type SigningKeyStore,
  s256Challenge,
} from "@softistx/janus-oauth";
import { registerClient } from "@/clients/register-client";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesFor } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { createClavixOAuthIssuers } from "@/oauth/issuers";
import type { AuthFor, ClaimsFor, RolesFor } from "@/oauth/ports";

export const DOMAIN = (await import("@/config/env")).env.CLAVIX_DOMAIN;
export const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

/**
 * A real OAuth flow (authorize, approve, code exchange) against the tenants of
 * the test database, with a fake user pool: every user id is known, claims are
 * the user's e-mail. For the specs that read what a token carries or whether
 * it still works.
 */
export function createFlow(options: { rolesFor?: RolesFor } = {}) {
  const keys = new Map<string, SigningKeyStore>();
  const signingKeysFor = (tenantId: string) => {
    let store = keys.get(tenantId);
    if (store === undefined) {
      store = createMemorySigningKeys();
      keys.set(tenantId, store);
    }
    return store;
  };
  const authFor: AuthFor = () => ({
    authenticate: async () => null,
    findUser: async (id) => ({ id, active: true }),
  });
  const claimsFor: ClaimsFor = () => async (subject) => ({
    email: `${subject.id}@end.test`,
    email_verified: true,
  });
  const issuers = createClavixOAuthIssuers({
    resolver: tenantResolver,
    db: oauthDb,
    signingKeysFor,
    authFor,
    claimsFor,
    resourcesFor,
    ...(options.rolesFor === undefined ? {} : { rolesFor: options.rolesFor }),
  });
  const url = (slug: string, path: string) =>
    `https://${slug}.${DOMAIN}${path}`;
  const get = (slug: string, path: string, authorization?: string) =>
    issuers.handle(
      new Request(url(slug, path), {
        headers: authorization === undefined ? {} : { authorization },
      }),
    );
  const post = (
    slug: string,
    path: string,
    body: Record<string, string>,
    authorization?: string,
  ) =>
    issuers.handle(
      new Request(url(slug, path), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: new URLSearchParams(body),
      }),
    );
  const basic = (id: string, secret: string) =>
    `Basic ${btoa(`${id}:${secret}`)}`;
  const clients: Record<string, { id: string; secret: string }> = {};

  /** A tenant with a signing key, a confidential client `backend` and these resources (each with a `read` scope). */
  async function setUp(slug: string, resourceUris: readonly string[] = []) {
    const { id } = await tenantsService.create({ slug, name: slug });
    const tenant = await tenantResolver.resolveHost(`${slug}.${DOMAIN}`);
    if (tenant === null) throw new Error("tenant not resolved");
    await rotateSigningKeys(signingKeysFor(tenant.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    for (const uri of resourceUris) {
      await registerStoredResource({ tenant: slug, uri, scopes: ["read"] });
    }
    const registered = await registerClient(
      { db: oauthDb, findTenant },
      {
        tenant: slug,
        name: "Back end",
        clientId: "backend",
        redirectUris: [REDIRECT],
        type: "confidential",
      },
    );
    clients[slug] = { id: "backend", secret: registered.clientSecret ?? "" };
    return { tenantId: id };
  }

  /** authorize, approve as `userId`, code exchange. No `resource`: the issuer's userinfo. */
  async function login(
    slug: string,
    scope: string,
    options: {
      resource?: string;
      userId?: string;
      client?: { id: string; secret: string };
    } = {},
  ) {
    const client =
      options.client ?? (clients[slug] as { id: string; secret: string });
    const { resource, userId = `user-${slug}` } = options;
    const authorize = await get(
      slug,
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: REDIRECT,
        code_challenge: await s256Challenge(VERIFIER),
        code_challenge_method: "S256",
        scope,
        nonce: "n-0S6_WzA2Mj",
        ...(resource === undefined ? {} : { resource }),
        state: "xyz",
      })}`,
    );
    expect(authorize.status).toBe(302);
    const consent = new URL(
      authorize.headers.get("location") ?? "",
      url(slug, "/"),
    );
    const server = await issuers.serverFor(new Request(url(slug, "/")));
    if (server === null) throw new Error(`no server for ${slug}`);
    const { redirectTo } = await server.approve(
      { id: userId },
      consent.searchParams.get("request_id") ?? "",
      { scopes: scope.split(" "), authTime: new Date() },
    );
    return post(
      slug,
      "/token",
      {
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        ...(resource === undefined ? {} : { resource }),
      },
      basic(client.id, client.secret),
    );
  }

  const tokensOf = async (
    slug: string,
    scope: string,
    options: {
      resource?: string;
      userId?: string;
      client?: { id: string; secret: string };
    } = {},
  ) => {
    const response = await login(slug, scope, options);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string | null;
    };
  };

  return { issuers, setUp, login, tokensOf, get, post, url, basic, clients };
}
