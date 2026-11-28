# Protect a resource server with Clavix tokens

A resource server is your own API that accepts Clavix access tokens. Clavix
does the sign-in and the RBAC (the Resource's permission catalogue, roles and
the `enforceRbac` flag); your API checks each token and applies its own rules
with [`@softistx/limix`](https://www.npmjs.com/package/@softistx/limix). This
page goes from the discovery document to an allowed and a refused call.

The code below is one file, `docs/guide/examples/resource-server.ts`, quoted in
pieces. `src/oauth/resource-server.guide.spec.ts` runs it against the real
issuer and checks that every block here is a verbatim part of that file.

Install the two libraries (limix 0.8 or later):

```sh
bun add jose @softistx/limix
```

You need the tenant's issuer (`https://<slug>.<CLAVIX_DOMAIN>`) and the `uri` of
your Resource in Clavix, which is the `aud` of every token meant for you.

## 1. Discovery and keys

The tenant's discovery document is at `<issuer>/.well-known/openid-configuration`
and names the keys (`jwks_uri`, `<issuer>/jwks.json`). Tokens are signed with
ES256.

```sh
curl -s https://acme.clavix.example/.well-known/openid-configuration
```

```ts
// docs/guide/examples/resource-server.ts
import {
  type Claims,
  compilePolicy,
  definePolicy,
  evaluateRest,
  type RestRulesInput,
} from "@softistx/limix";
import {
  createRemoteJWKSet,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
```

```ts
// docs/guide/examples/resource-server.ts
/** What the resource server knows about Clavix: the tenant's issuer and its own Resource URI. */
export interface Trust {
  /** The tenant's issuer, e.g. `https://acme.clavix.example` (no trailing slash). */
  issuer: string;
  /** The Resource's `uri` in Clavix: the `aud` every accepted token carries. */
  resource: string;
}
```

```ts
// docs/guide/examples/resource-server.ts
/** Step 1: read the tenant's discovery document and take its JWKS address. */
export async function discover(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<{ jwksUri: string }> {
  const response = await fetcher(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery answered ${response.status}`);
  const document: unknown = await response.json();
  if (typeof document !== "object" || document === null) {
    throw new Error("discovery is not a JSON object");
  }
  const { issuer: named, jwks_uri: jwksUri } = document as Record<
    string,
    unknown
  >;
  // The document must name the issuer you asked for, or a proxy could swap it.
  if (named !== issuer || typeof jwksUri !== "string") {
    throw new Error("discovery names another issuer or no jwks_uri");
  }
  return { jwksUri };
}
```

```ts
// docs/guide/examples/resource-server.ts
/** The keys of the issuer: fetched on demand, cached, and refetched when a `kid` is unknown. */
export const remoteKeys = (jwksUri: string): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(jwksUri));
```

`createRemoteJWKSet` fetches the keys when first needed, caches them and
refetches when a token carries an unknown `kid` (a key rotation). Build it once
at start-up, not per request.

## 2. Verify the access token

```ts
// docs/guide/examples/resource-server.ts
/** Step 2: verify the access token. Throws a `jose` error when anything is wrong. */
export async function verifyAccessToken(
  token: string,
  keys: JWTVerifyGetKey,
  trust: Trust,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: trust.issuer,
    audience: trust.resource,
    algorithms: ["ES256"],
    clockTolerance: 5,
  });
  if (payload.sub === undefined)
    throw new errors.JWTInvalid("the token has no sub");
  return payload;
}
```

- `issuer` and `audience` make a token for another tenant or another Resource
  fail; `audience` is your Resource's `uri`.
- `algorithms` pins ES256, so a token cannot choose a weaker one.
- `clockTolerance` allows a few seconds of drift between the two servers.

Answer a refused token with `401` and a `WWW-Authenticate` header (RFC 6750):

```ts
// docs/guide/examples/resource-server.ts
/** The `WWW-Authenticate` value of a refused token (RFC 6750). */
export const challenge = (error: "invalid_token" | "insufficient_scope") =>
  `Bearer error="${error}"`;
```

A failure to reach Clavix for the keys is not the caller's fault: answer `503`
yourself, never `401`.

## 3. Map the claims to limix

The access token carries `scope` (a space-separated string), `roles` (the
user's role names) and, when the Resource has `enforceRbac` on, `permissions`
(the scope names of the Resource that the user's roles grant; `[]` for a user
with no role). With the flag off the claim is absent. Only access tokens carry
it: never an id_token, userinfo or a `client_credentials` token.

```ts
// docs/guide/examples/resource-server.ts
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;

/** Step 3: the token's claims as limix claims. */
export function claimsOf(payload: JWTPayload): Claims {
  const roles = strings(payload["roles"]);
  const permissions = strings(payload["permissions"]);
  return {
    authenticated: true,
    subject: { type: "user", id: payload.sub ?? "" },
    // limix reads `scope` as the space-separated string the token carries.
    scope: typeof payload["scope"] === "string" ? payload["scope"] : "",
    ...(roles === undefined ? {} : { roles }),
    // Absent when the Resource does not enforce RBAC: then `scope` alone decides.
    ...(permissions === undefined ? {} : { permissions }),
  };
}
```

limix does the combining: a permission holds when it is in `scope` and, when the
`permissions` claim is present, also in `permissions`. The mapper only passes the
claims through, and leaves `permissions` out when the token has none.

## 4. The rules file

The permission names are the Resource's catalogue in Clavix (its scopes).
`definePolicy` takes a list of rule blocks per transport; a route that matches no
rule is refused.

```ts
// docs/guide/examples/resource-server.ts
/** Step 4: the rules. The permission names are the Resource's catalogue in Clavix. */
export const invoiceRules = {
  "GET /invoices": { permissions: [["invoices:read"]] },
  "GET /invoices/:id": { permissions: [["invoices:read"]] },
  "POST /invoices": { permissions: [["invoices:write"]] },
  "DELETE /invoices/:id": { permissions: [["invoices:delete"]] },
  "GET /reports": { roles: [["auditor"]] },
} satisfies RestRulesInput;

export const policy = compilePolicy(
  definePolicy({
    limix: 1,
    global: { unmatched: "deny" },
    rest: [invoiceRules],
  }),
);
```

## 5. Check a request

```ts
// docs/guide/examples/resource-server.ts
/** The whole check of one request: verify, map, decide. */
export async function authorize(
  request: { method: string; path: string; token: string },
  keys: JWTVerifyGetKey,
  trust: Trust,
) {
  const claims = claimsOf(await verifyAccessToken(request.token, keys, trust));
  return evaluateRest(policy, {
    method: request.method,
    path: request.path,
    claims,
  });
}
```

`evaluateRest` answers `{ allow: true }` or `{ allow: false, refusal }` with the
status to send: `401` `auth.errors.unauthenticated`, `403`
`auth.errors.forbidden`, or `503` `limix.errors.unavailable`.

The HTTP edge, with the three answers:

```ts
// docs/guide/examples/resource-server.ts
/** Step 5: the HTTP edge. 401 for a missing or bad token, 403 for a refusal, else your code. */
export const handler =
  (keys: JWTVerifyGetKey, trust: Trust) =>
  async (request: Request): Promise<Response> => {
    const token = /^Bearer (\S+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (token === undefined) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="api"' },
      });
    }
    try {
      const decision = await authorize(
        {
          method: request.method,
          path: new URL(request.url).pathname,
          token,
        },
        keys,
        trust,
      );
      if (!decision.allow) {
        const { code, status } = decision.refusal;
        return Response.json(
          { code },
          {
            status,
            headers:
              status === 403
                ? { "www-authenticate": challenge("insufficient_scope") }
                : {},
          },
        );
      }
      return Response.json({ invoices: [] }); // your route runs here
    } catch (error) {
      // A token that fails verification is 401; a failure to reach the issuer is yours (503).
      if (
        error instanceof errors.JOSEError &&
        !(error instanceof errors.JWKSTimeout)
      ) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": challenge("invalid_token") },
        });
      }
      throw error;
    }
  };
```

### An allowed call and a refused call

Say Alice holds a role granting `invoices:read` and `invoices:write` on the
Resource, and she asked for the three scopes `invoices:read invoices:write
invoices:delete`. Her token's `scope` holds the three, its `permissions` only two.

```sh
curl -i https://api.example/v1/invoices -H "Authorization: Bearer $TOKEN"
```

```http
HTTP/1.1 200 OK
content-type: application/json

{"invoices":[]}
```

`invoices:delete` is in her `scope` but not in her `permissions`, so Clavix's
role model refuses it:

```sh
curl -i -X DELETE https://api.example/v1/invoices/42 -H "Authorization: Bearer $TOKEN"
```

```http
HTTP/1.1 403 Forbidden
www-authenticate: Bearer error="insufficient_scope"
content-type: application/json

{"code":"auth.errors.forbidden"}
```

Without a token the answer is `401` with `www-authenticate: Bearer realm="api"`;
with a forged or expired token, `401` with `Bearer error="invalid_token"`.

## 6. Relations stay in your app

Clavix knows roles and permissions, not who owns which invoice. Relations
(this user may read this invoice) stay in your application, in your own
[janus](https://www.npmjs.com/package/@softistx/janus) store, checked through
`@softistx/limix-janus`: `janusRelations({ access })` is a limix
`RelationChecker` over `permissions({ model, store })` from
`@softistx/janus/permissions`, and `checkModel(policy, model)` fails at start-up
when a rule names a relation the model lacks. See that package's `docs/janus.md`.
Clavix never receives your relations.

## 7. What is coming

Slice 5.2b (#30) narrows the token's `scope` to the requested scope intersected
with the user's permissions, on the token itself. Until then `scope` is what the
client requested and the `permissions` claim is what filters; the rules above
keep working unchanged, since limix already requires both.
