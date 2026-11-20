import { s256Challenge } from "@softistx/janus-oauth";
import { registerClient } from "@/clients/register-client";
import { mongo } from "@/config/db";
import { env } from "@/config/env";
import { createIssuers } from "@/config/oauth";
import { oauthDb } from "@/config/oauth-db";
import { redis } from "@/config/redis";
import { catalog, registerStoredResource } from "@/config/resources";
import {
  tenantBySlug,
  tenantResolver,
  tenantsCollection,
  tenantsService,
} from "@/config/tenancy";
import { authFor, claimsFor, forTenant } from "@/config/users";
import { registerTenant } from "@/modules/tenants/register-tenant";

// Seeds the load test (docs/operations.md, "Load test"): TENANTS
// tenants, each with CHAINS public clients and one refresh-token chain per
// client, minted through the real authorize, approve and code exchange of the
// real issuers (a fixed user stands in for the hosted sign-in). Idempotent for
// tenants and clients; every run mints new chains. Prints one JSON document on
// stdout: { domain, tenants: [{ slug, chains: [{ clientId, token }], confidential: { clientId, secret } }] }.
// `confidential` is the client of the client_credentials scenario: the resource
// opts in (`allowClientCredentials`) and the secret is rotated on every run, so
// the seed always holds a working one.
const TENANTS = Number(Bun.env["LOAD_TENANTS"] ?? 50);
const CHAINS = Number(Bun.env["LOAD_CHAINS"] ?? 4);
const REDIRECT = "https://app.example/callback";
const VERIFIER = "v".repeat(64);
const clientOf = (chain: number) => `load-${chain}`;
const RESOURCE = "https://api.load.test/v1";
const MACHINE = "load-cc";

// The real end-user authentication of the tenants: the refresh grant checks the
// user in the tenant's store, so each tenant gets one real user (a refresh of a
// made-up user is `invalid_grant`). The hosted sign-in is replaced by `approve`.
// One client per chain: a second grant of the same user and client replaces the first.
let chain = 0;
const issuers = createIssuers(authFor, claimsFor);
const userIds = new Map<string, string>();

const url = (slug: string, path: string) =>
  `https://${slug}.${env.CLAVIX_DOMAIN}${path}`;

async function mintRefreshToken(slug: string): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientOf(chain),
    redirect_uri: REDIRECT,
    code_challenge: await s256Challenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "read",
    resource: RESOURCE,
    state: "load",
  });
  // Tenants require pushed authorization requests (RFC 9126): push first.
  const par = await issuers.handle(
    new Request(url(slug, "/par"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: query,
    }),
  );
  const pushed = (await par.json()) as { request_uri?: string };
  if (par.status !== 201 || pushed.request_uri === undefined) {
    throw new Error(
      `${slug}: par answered ${par.status} ${JSON.stringify(pushed)}`,
    );
  }
  const authorize = await issuers.handle(
    new Request(
      url(
        slug,
        `/authorize?${new URLSearchParams({ client_id: clientOf(chain), request_uri: pushed.request_uri })}`,
      ),
    ),
  );
  const consent = new URL(
    authorize.headers.get("location") ?? "",
    url(slug, "/"),
  );
  const requestId = consent.searchParams.get("request_id");
  if (authorize.status !== 302 || requestId === null) {
    throw new Error(
      `${slug}: authorize answered ${authorize.status} ${authorize.headers.get("location")}`,
    );
  }
  const server = await issuers.serverFor(new Request(url(slug, "/")));
  if (server === null) throw new Error(`${slug}: no server`);
  const { redirectTo } = await server.approve(
    { id: userIds.get(slug) as string },
    requestId,
    { scopes: ["read"] },
  );
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  const token = await issuers.handle(
    new Request(url(slug, "/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientOf(chain),
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    }),
  );
  const body = (await token.json()) as { refresh_token?: string };
  if (token.status !== 200 || body.refresh_token === undefined) {
    throw new Error(
      `${slug}: code exchange answered ${token.status} ${JSON.stringify(body)}`,
    );
  }
  return body.refresh_token;
}

const out: {
  domain: string;
  tenants: {
    slug: string;
    chains: { clientId: string; token: string }[];
    confidential: { clientId: string; secret: string };
  }[];
} = { domain: env.CLAVIX_DOMAIN, tenants: [] };
try {
  for (let i = 0; i < TENANTS; i++) {
    const slug = `load${String(i).padStart(2, "0")}`;
    await registerTenant(
      { service: tenantsService, collection: tenantsCollection },
      { slug, name: `Load ${i}` },
    );
    await registerStoredResource({
      tenant: slug,
      uri: RESOURCE,
      scopes: ["read"],
    });
    const owner = await tenantBySlug(slug);
    if (owner === undefined) throw new Error(`${slug}: tenant not found`);
    const stored = (await catalog.listResources(owner._id)).find(
      (resource) => resource.uri === RESOURCE,
    );
    if (stored === undefined) throw new Error(`${slug}: resource not stored`);
    await catalog.updateResource(owner._id, stored._id.toHexString(), {
      allowClientCredentials: true,
    });
    const machine = await registerClient(
      { db: oauthDb, findTenant: tenantBySlug },
      {
        tenant: slug,
        name: "Load machine",
        clientId: MACHINE,
        redirectUris: [],
        type: "confidential",
        grants: ["client_credentials"],
        allowedScopes: ["read"],
        defaultScopes: ["read"],
        rotateSecret: true,
      },
    );
    const resolved = await tenantResolver.resolveHost(
      `${slug}.${env.CLAVIX_DOMAIN}`,
    );
    const janus = resolved === null ? null : await forTenant(resolved);
    if (janus === null) throw new Error(`${slug}: no tenant instance`);
    const email = "load@load.test";
    const user =
      (await janus.findByEmail(email)) ??
      (await janus.create({ email, name: "Load" }));
    userIds.set(slug, user.id);
    const chains: { clientId: string; token: string }[] = [];
    for (let j = 0; j < CHAINS; j++) {
      chain = j;
      await registerClient(
        { db: oauthDb, findTenant: tenantBySlug },
        {
          tenant: slug,
          name: `Load ${j}`,
          clientId: clientOf(j),
          redirectUris: [REDIRECT],
        },
      );
      chains.push({
        clientId: clientOf(j),
        token: await mintRefreshToken(slug),
      });
    }
    out.tenants.push({
      slug,
      chains,
      confidential: { clientId: MACHINE, secret: machine.clientSecret ?? "" },
    });
  }
  console.log(JSON.stringify(out));
} finally {
  await mongo.close();
  await redis?.close();
}
