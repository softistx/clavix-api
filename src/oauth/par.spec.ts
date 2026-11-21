import { beforeAll, describe, expect, test } from "bun:test";
import { s256Challenge } from "@softistx/janus-oauth";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantsService } from "@/config/tenancy";
import { registerClient } from "@/modules/clients/register-client";
import { createFlow, REDIRECT } from "~/oauth-flow";

const VERIFIER = "p".repeat(64);
let pusherSecret = "";
const flow = createFlow();
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });

const params = async (clientId: string) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: await s256Challenge(VERIFIER),
  code_challenge_method: "S256",
  scope: "openid",
  state: "xyz",
});

const push = async (slug: string, clientId: string, secret?: string) =>
  flow.post(
    slug,
    "/par",
    await params(clientId),
    secret === undefined ? undefined : flow.basic(clientId, secret),
  );

const authorize = (slug: string, query: Record<string, string>) =>
  flow.get(slug, `/authorize?${new URLSearchParams(query)}`);

const secretOf = (slug: string) => flow.clients[slug]?.secret ?? "";

beforeAll(async () => {
  await flow.setUp("par-on", [], { par: true });
  await flow.setUp("par-off");
  await flow.setUp("par-client");
  const registered = await registerClient(
    { now: () => new Date(), db: oauthDb, findTenant },
    {
      tenant: "par-client",
      name: "Pushing",
      clientId: "pusher",
      redirectUris: [REDIRECT],
      type: "confidential",
      requirePar: true,
    },
  );
  pusherSecret = registered.clientSecret ?? "";
});

// An /authorize refusal is a redirect to the client with `error=` when the
// client is known, a JSON body otherwise.
async function errorOf(response: Response): Promise<string | null> {
  if (response.status === 302) {
    const location = response.headers.get("location") ?? "";
    return new URL(location, "https://x.invalid").searchParams.get("error");
  }
  return ((await response.json()) as { error: string }).error;
}

describe("pushed authorization requests", () => {
  test("a new tenant requires them, an existing one is off", async () => {
    const created = await tenantsService.create({ slug: "par-new", name: "N" });
    expect(created.oauth.par.required).toBe(true);
    const off = await findTenant("par-off");
    expect(off?.oauth.par.required).toBe(false);
  });

  test("a tenant that requires PAR refuses /authorize without a request_uri", async () => {
    const response = await authorize("par-on", await params("backend"));
    expect(await errorOf(response)).toBe("invalid_request");
  });

  test("/par with Basic auth, then /authorize?request_uri= completes code + PKCE", async () => {
    const pushed = await push("par-on", "backend", secretOf("par-on"));
    expect(pushed.status).toBe(201);
    const { request_uri } = (await pushed.json()) as { request_uri: string };
    const redirect = await authorize("par-on", {
      client_id: "backend",
      request_uri,
    });
    expect(redirect.status).toBe(302);
    const consent = new URL(
      redirect.headers.get("location") ?? "",
      flow.url("par-on", "/"),
    );
    expect(consent.pathname).toBe("/consent");
    const requestId = consent.searchParams.get("request_id") ?? "";
    expect(requestId).not.toBe("");

    // The request_uri is spent; the signed-out user's way back is the consent
    // request, which does not redeem it again.
    const again = await authorize("par-on", {
      client_id: "backend",
      request_uri,
    });
    expect(await errorOf(again)).toBe("invalid_request_uri");

    const server = await flow.issuers.serverFor(
      new Request(flow.url("par-on", "/")),
    );
    if (server === null) throw new Error("no server");
    const { redirectTo } = await server.approve({ id: "u1" }, requestId, {
      scopes: ["openid"],
      authTime: new Date(),
    });
    const token = await flow.post(
      "par-on",
      "/token",
      {
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      },
      flow.basic("backend", secretOf("par-on")),
    );
    expect(token.status).toBe(200);
  });

  test("a client's own requirement works on a tenant that does not require it", async () => {
    // Another client of the same tenant, not requiring it, authorizes directly.
    const direct = await authorize("par-client", await params("backend"));
    expect(direct.status).toBe(302);
    const refused = await authorize("par-client", await params("pusher"));
    expect(await errorOf(refused)).toBe("invalid_request");
    const pushed = await push("par-client", "pusher", pusherSecret);
    expect(pushed.status).toBe(201);
    const { request_uri } = (await pushed.json()) as { request_uri: string };
    const accepted = await authorize("par-client", {
      client_id: "pusher",
      request_uri,
    });
    expect(accepted.status).toBe(302);
  });

  test("discovery advertises the requirement only where it is on", async () => {
    const meta = async (slug: string) =>
      (await (
        await flow.get(slug, "/.well-known/oauth-authorization-server")
      ).json()) as Record<string, unknown>;
    const on = await meta("par-on");
    expect(on["require_pushed_authorization_requests"]).toBe(true);
    expect(on["pushed_authorization_request_endpoint"]).toBe(
      flow.url("par-on", "/par"),
    );
    const off = await meta("par-off");
    expect(off["require_pushed_authorization_requests"]).toBeUndefined();
    expect(off["pushed_authorization_request_endpoint"]).toBeDefined();
  });
});

describe("the /par endpoint of a suspended tenant", () => {
  test("is refused 403 TENANT_SUSPENDED", async () => {
    const { withTenantState } = await import("./tenant-state");
    const { tenantResolver } = await import("@/config/tenancy");
    const tenant = await findTenant("par-off");
    if (tenant === undefined) throw new Error("no tenant");
    await tenantsService.suspend(tenant._id);
    const guarded = withTenantState(flow.issuers, { resolver: tenantResolver });
    const response = await guarded.handle(
      new Request(flow.url("par-off", "/par"), { method: "POST" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TENANT_SUSPENDED" });
  });
});
