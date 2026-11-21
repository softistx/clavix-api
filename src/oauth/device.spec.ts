import { beforeAll, describe, expect, test } from "bun:test";
import { DEVICE_GRANT } from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { registerClient } from "@/modules/clients/register-client";
import { createFlow } from "~/oauth-flow";
import { withTenantState } from "./tenant-state";

const flow = createFlow();
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const DEVICES = "oauthPartitionedDeviceAuthorizations";

interface Codes {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

const register = (
  slug: string,
  clientId: string,
  grants: readonly string[] | undefined,
) =>
  registerClient(
    { now: () => new Date(), db: oauthDb, findTenant },
    {
      tenant: slug,
      name: `Device ${clientId}`,
      clientId,
      redirectUris: [],
      ...(grants === undefined ? {} : { grants }),
    },
  );

beforeAll(async () => {
  for (const slug of ["dev-a", "dev-b", "dev-susp"]) {
    await flow.setUp(slug);
    await register(slug, "tv", [DEVICE_GRANT]);
  }
  await register("dev-a", "tv-refresh", [DEVICE_GRANT, "refresh_token"]);
});

const ask = (slug: string, clientId: string, scope = "openid email") =>
  flow.post(slug, "/device_authorization", { client_id: clientId, scope });

const codesOf = async (slug: string, clientId = "tv", scope?: string) => {
  const response = await ask(slug, clientId, scope);
  expect(response.status).toBe(200);
  return (await response.json()) as Codes;
};

const poll = (slug: string, clientId: string, deviceCode: string) =>
  flow.post(slug, "/token", {
    grant_type: DEVICE_GRANT,
    device_code: deviceCode,
    client_id: clientId,
  });

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: string }).error;

// A poll may not come before the interval: the specs that poll twice move the
// last poll into the past instead of waiting.
const rewind = () =>
  oauthDb
    .collection(DEVICES)
    .updateMany({}, { $set: { lastPolledAt: new Date(0) } });

async function approve(slug: string, userCode: string, userId = "user-1") {
  const server = await flow.issuers.serverFor(new Request(flow.url(slug, "/")));
  if (server === null) throw new Error("no server");
  await server.approveDevice({ id: userId }, userCode, {
    scopes: ["openid", "email"],
    authTime: new Date(),
  });
}

describe("the device authorization grant", () => {
  test("codes, authorization_pending, approval, then tokens with an id_token", async () => {
    const codes = await codesOf("dev-a");
    expect(codes.verification_uri).toBe(flow.url("dev-a", "/device"));
    expect(codes.verification_uri_complete).toBe(
      `${flow.url("dev-a", "/device")}?user_code=${codes.user_code}`,
    );
    expect(codes.user_code).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );

    const pending = await poll("dev-a", "tv", codes.device_code);
    expect(pending.status).toBe(400);
    expect(await errorOf(pending)).toBe("authorization_pending");

    await approve("dev-a", codes.user_code.toLowerCase().replace("-", " "));
    await rewind();
    const tokens = await poll("dev-a", "tv", codes.device_code);
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
    };
    expect(body.id_token).toBeDefined();
    expect(decodeJwt(body.id_token ?? "")["sub"]).toBe("user-1");
    expect(decodeJwt(body.access_token)["sub"]).toBe("user-1");
    // A device-only client gets no refresh token.
    expect(body.refresh_token).toBeUndefined();

    // The code is spent.
    await rewind();
    expect(await errorOf(await poll("dev-a", "tv", codes.device_code))).toBe(
      "invalid_grant",
    );
  });

  test("a client that lists refresh_token gets one", async () => {
    const codes = await codesOf("dev-a", "tv-refresh");
    await approve("dev-a", codes.user_code);
    const tokens = await poll("dev-a", "tv-refresh", codes.device_code);
    expect(tokens.status).toBe(200);
    expect(
      ((await tokens.json()) as { refresh_token?: string }).refresh_token,
    ).toBeTruthy();
  });

  test("polling before the interval is slow_down", async () => {
    const codes = await codesOf("dev-a");
    expect(await errorOf(await poll("dev-a", "tv", codes.device_code))).toBe(
      "authorization_pending",
    );
    expect(await errorOf(await poll("dev-a", "tv", codes.device_code))).toBe(
      "slow_down",
    );
  });

  test("a denied request answers access_denied", async () => {
    const codes = await codesOf("dev-a");
    const server = await flow.issuers.serverFor(
      new Request(flow.url("dev-a", "/")),
    );
    await server?.denyDevice(codes.user_code);
    expect(await errorOf(await poll("dev-a", "tv", codes.device_code))).toBe(
      "access_denied",
    );
  });

  test("a lapsed request answers expired_token", async () => {
    const codes = await codesOf("dev-a");
    await oauthDb
      .collection(DEVICES)
      .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await errorOf(await poll("dev-a", "tv", codes.device_code))).toBe(
      "expired_token",
    );
  });

  test("an unknown device code is invalid_grant", async () => {
    expect(await errorOf(await poll("dev-a", "tv", "nope"))).toBe(
      "invalid_grant",
    );
  });

  test("a client without the device URN gets unauthorized_client", async () => {
    // `backend` records the default grants: the device grant is never implied.
    const response = await flow.post(
      "dev-a",
      "/device_authorization",
      { scope: "openid" },
      flow.basic("backend", flow.clients["dev-a"]?.secret ?? ""),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("unauthorized_client");
  });

  test("a scope the issuer does not offer is invalid_scope", async () => {
    const response = await ask("dev-a", "tv", "admin");
    expect(await errorOf(response)).toBe("invalid_scope");
  });

  test("a code of tenant A is unknown on B, and its client does not exist there", async () => {
    const codes = await codesOf("dev-a");
    expect(await errorOf(await poll("dev-b", "tv", codes.device_code))).toBe(
      "invalid_grant",
    );
    const server = await flow.issuers.serverFor(
      new Request(flow.url("dev-b", "/")),
    );
    expect(await server?.deviceRequest(codes.user_code)).toBeNull();
    // Still pending on A.
    await approve("dev-a", codes.user_code);
  });

  test("the discovery document announces the endpoint and the grant", async () => {
    const meta = (await (
      await flow.get("dev-a", "/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(meta["device_authorization_endpoint"]).toBe(
      flow.url("dev-a", "/device_authorization"),
    );
    expect(meta["grant_types_supported"]).toContain(DEVICE_GRANT);
  });
});

describe("tenant state", () => {
  test("a suspended tenant's /device_authorization is 403 TENANT_SUSPENDED", async () => {
    const tenant = await findTenant("dev-susp");
    if (tenant === undefined) throw new Error("no tenant");
    await tenantsService.suspend(tenant._id);
    const guarded = withTenantState(flow.issuers, { resolver: tenantResolver });
    const response = await guarded.handle(
      new Request(flow.url("dev-susp", "/device_authorization"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "tv", scope: "openid" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TENANT_SUSPENDED" });
  });

  test("a token issued by the device grant counts its user as active", async () => {
    const active: string[] = [];
    const guarded = withTenantState(flow.issuers, {
      resolver: tenantResolver,
      onActive: (tenantId, userId) => {
        active.push(`${tenantId}/${userId}`);
      },
    });
    const codes = await codesOf("dev-b");
    await approve("dev-b", codes.user_code, "user-active");
    const response = await guarded.handle(
      new Request(flow.url("dev-b", "/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: codes.device_code,
          client_id: "tv",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const tenant = await findTenant("dev-b");
    expect(active).toEqual([`${tenant?._id.toHexString()}/user-active`]);
  });
});
