import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import {
  authorize,
  handler,
  remoteKeys,
  verifyAccessToken,
} from "../../docs/guide/examples/resource-server";

// The guide's refusals with keys made here: no issuer needed.
const trust = {
  issuer: "https://acme.clavix.test",
  resource: "https://api.test/",
};
const pair = await generateKeyPair("ES256");
const other = await generateKeyPair("ES384");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
const keys = createLocalJWKSet({ keys: [jwk] });

const sign = (
  claims: Record<string, unknown>,
  options: {
    alg?: string;
    typ?: string;
    kid?: string;
    exp?: string;
    key?: typeof pair.privateKey;
  } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({
      alg: options.alg ?? "ES256",
      typ: options.typ ?? "at+jwt",
      kid: options.kid ?? "k1",
    })
    .setIssuer(trust.issuer)
    .setAudience(trust.resource)
    .setExpirationTime(options.exp ?? "5m")
    .sign(options.key ?? pair.privateKey);

const serve = (getKey: JWTVerifyGetKey, bearer: string) =>
  handler(
    getKey,
    trust,
  )(
    new Request("https://api.test/invoices", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
const failing =
  (error: Error): JWTVerifyGetKey =>
  async () => {
    throw error;
  };

describe("the guide's resource server, refusals and failures", () => {
  test("a scope-only token (RBAC off) is decided on scope alone", async () => {
    const make = (scope: string) => sign({ sub: "u1", scope });
    const call = async (scope: string, method: string, path: string) =>
      authorize({ method, path, token: await make(scope) }, keys, trust);
    expect(await call("invoices:delete", "DELETE", "/invoices/1")).toEqual({
      allow: true,
    });
    expect(await call("invoices:read", "DELETE", "/invoices/1")).toMatchObject({
      allow: false,
      refusal: { status: 403 },
    });
  });

  test.each([
    [
      "an expired token",
      () => sign({ sub: "u1" }, { exp: "-1m" }),
      errors.JWTExpired,
    ],
    ["a token with no sub", () => sign({}), errors.JWTInvalid],
    [
      "a disallowed alg",
      () => sign({ sub: "u1" }, { alg: "ES384", key: other.privateKey }),
      errors.JOSEAlgNotAllowed,
    ],
    [
      "a wrong typ",
      () => sign({ sub: "u1" }, { typ: "JWT" }),
      errors.JWTClaimValidationFailed,
    ],
    [
      "an unknown kid",
      () => sign({ sub: "u1" }, { kid: "gone" }),
      errors.JWKSNoMatchingKey,
    ],
  ])("%s is a 401 invalid_token", async (_name, make, kind) => {
    const token = await make();
    await expect(verifyAccessToken(token, keys, trust)).rejects.toBeInstanceOf(
      kind,
    );
    const response = await serve(keys, token);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
  });

  test("a malformed token is a 401", async () => {
    expect((await serve(keys, "not-a-jwt")).status).toBe(401);
  });

  test.each([
    ["a JWKS timeout", new errors.JWKSTimeout()],
    ["an invalid JWKS", new errors.JWKSInvalid("no keys")],
    ["a generic jose failure", new errors.JOSEError("Expected 200 OK")],
    ["a network failure", new TypeError("fetch failed")],
  ])("%s is a 503, never a 401", async (_name, error) => {
    const response = await serve(failing(error), await sign({ sub: "u1" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  test("a JWKS endpoint that answers 500 is a 503", async () => {
    const down = remoteKeys(
      "https://acme.clavix.test/jwks.json",
      async () => new Response("oops", { status: 500 }),
    );
    expect((await serve(down, await sign({ sub: "u1" }))).status).toBe(503);
  });

  test("the guide's example blocks are the example file, and show every export", () => {
    const source = readFileSync(
      "docs/guide/examples/resource-server.ts",
      "utf8",
    );
    const guide = readFileSync("docs/guide/resource-server.md", "utf8");
    const marker = "// docs/guide/examples/resource-server.ts\n";
    const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? "")
      .filter((block) => block.startsWith(marker))
      .map((block) => block.slice(marker.length).trimEnd());
    expect(blocks.length).toBeGreaterThan(3);
    for (const block of blocks) expect(source).toContain(block);
    const shown = blocks.join("\n");
    const exported = [
      ...source.matchAll(
        /^export (?:async )?(?:function|const|interface|type) (\w+)/gm,
      ),
    ].map((m) => m[1] ?? "");
    expect(exported.length).toBeGreaterThan(10);
    for (const name of exported) expect(shown).toContain(name);
  });
});
