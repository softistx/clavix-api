import { expect } from "bun:test";
import { s256Challenge } from "@softistx/janus-oauth";
import type { createClavixOAuthIssuers } from "@/oauth/issuers";
import { jsonOf, tokenBody } from "~/json";
import { defined } from "~/narrow";

type Issuers = ReturnType<typeof createClavixOAuthIssuers>;
/** The client of a tenant's flow. */
export type FlowClient = { id: string; secret: string };
/** What a flow step takes beside the tenant and the scope. */
export interface FlowOptions {
  resource?: string;
  userId?: string;
  client?: FlowClient;
}

const VERIFIER = "v".repeat(64);

/** The tenant's host and the request helpers over the issuers' `handle`. */
export function requestsOf(issuers: Pick<Issuers, "handle">, domain: string) {
  const url = (slug: string, path: string) =>
    `https://${slug}.${domain}${path}`;
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
    headers: Record<string, string> = {},
  ) =>
    issuers.handle(
      new Request(url(slug, path), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(authorization === undefined ? {} : { authorization }),
          ...headers,
        },
        body: new URLSearchParams(body),
      }),
    );
  return { url, get, post };
}

export const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${id}:${secret}`)}`;

/** The `/authorize` query of a code request with PKCE. */
async function authorizeQuery(
  client: FlowClient,
  redirect: string,
  scope: string,
  resource: string | undefined,
) {
  return new URLSearchParams({
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirect,
    code_challenge: await s256Challenge(VERIFIER),
    code_challenge_method: "S256",
    scope,
    nonce: "n-0S6_WzA2Mj",
    ...(resource === undefined ? {} : { resource }),
    state: "xyz",
  });
}

/** The steps of a code flow: authorize, approve, exchange. */
export function stepsOf(
  issuers: Pick<Issuers, "serverFor">,
  requests: ReturnType<typeof requestsOf>,
  clients: Record<string, FlowClient>,
  redirect: string,
) {
  const { url, get, post } = requests;

  /**
   * authorize, then approve as `userId`: the code, not yet exchanged (a spec
   * that drives the token request itself, DPoP proofs for instance).
   */
  async function authorizeCode(
    slug: string,
    scope: string,
    options: FlowOptions = {},
  ) {
    const client =
      options.client ?? defined(clients[slug], `the client of ${slug}`);
    const { resource, userId = `user-${slug}` } = options;
    const query = await authorizeQuery(client, redirect, scope, resource);
    const authorize = await get(slug, `/authorize?${query}`);
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
    return {
      client,
      /** The `/token` body of the code exchange. */
      body: {
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        redirect_uri: redirect,
        code_verifier: VERIFIER,
        ...(resource === undefined ? {} : { resource }),
      },
    };
  }

  /** authorize, approve as `userId`, code exchange. No `resource`: the issuer's userinfo. */
  async function login(slug: string, scope: string, options: FlowOptions = {}) {
    const { client, body } = await authorizeCode(slug, scope, options);
    return post(slug, "/token", body, basic(client.id, client.secret));
  }

  const tokensOf = async (
    slug: string,
    scope: string,
    options: FlowOptions = {},
  ) => {
    const response = await login(slug, scope, options);
    expect(response.status).toBe(200);
    return jsonOf(response, tokenBody);
  };

  return { authorizeCode, login, tokensOf };
}
