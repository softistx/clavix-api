# Protect a resource server with Clavix tokens

A resource server is your own API that accepts Clavix access tokens. Clavix
does the sign-in and the RBAC (the Resource's permission catalogue, roles and
the `enforceRbac` flag); your API checks each token and applies its own rules
with [`@softistx/limix`](https://www.npmjs.com/package/@softistx/limix). This
page goes from the discovery document to an allowed and a refused call.

Install the libraries (limix 0.8 or later). `@softistx/janus` and
`@softistx/limix-janus` are needed only for step 6, relations:

```sh
bun add jose @softistx/limix
bun add @softistx/janus @softistx/limix-janus
```

You need the tenant's issuer (`https://<slug>.<CLAVIX_DOMAIN>`) and the `uri` of
your Resource in Clavix, which is the `aud` of every token meant for you.
Refusals you may hit are in [troubleshooting](../troubleshooting.md#resource-server-refusals).

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
  createMemoryRelations,
  defineModel,
  permissions,
} from "@softistx/janus/permissions";
import {
  type Claims,
  compilePolicy,
  definePolicy,
  evaluateRest,
  type RestRulesInput,
} from "@softistx/limix";
import { checkModel, janusRelations } from "@softistx/limix-janus";
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
```

Every block of this page is part of one file, `docs/guide/examples/resource-server.ts`,
so the imports above serve all of them; the two `@softistx/janus*` imports are
needed only by step 6.

```ts
// docs/guide/examples/resource-server.ts
/** What the resource server knows about Clavix: the tenant's issuer and its own Resource URI. */
export interface Trust {
  /** The tenant's issuer, e.g. `https://acme.clavix.example` (no trailing slash). */
  issuer: string;
  /** The Resource's `uri` in Clavix: the `aud` every accepted token carries. */
  resource: string;
}

/** The part of `fetch` this code needs: a URL in, a response out (a test passes its own). */
export type Fetcher = (url: string) => Promise<Response>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
```

```ts
// docs/guide/examples/resource-server.ts
/** Step 1: read the tenant's discovery document and take its JWKS address. */
export async function discover(
  issuer: string,
  fetcher: Fetcher = (url) => fetch(url),
): Promise<{ jwksUri: string }> {
  const response = await fetcher(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery answered ${response.status}`);
  const document: unknown = await response.json();
  // The document must name the issuer you asked for, or a proxy could swap it.
  if (
    !isRecord(document) ||
    document["issuer"] !== issuer ||
    typeof document["jwks_uri"] !== "string"
  ) {
    throw new Error("discovery names another issuer or no jwks_uri");
  }
  return { jwksUri: document["jwks_uri"] };
}
```

```ts
// docs/guide/examples/resource-server.ts
/** The keys of the issuer: fetched on demand, cached, and refetched when a `kid` is unknown. */
export const remoteKeys = (
  jwksUri: string,
  fetcher?: Fetcher,
): JWTVerifyGetKey =>
  createRemoteJWKSet(
    new URL(jwksUri),
    fetcher === undefined ? {} : { [customFetch]: (url) => fetcher(url) },
  );
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
    typ: "at+jwt",
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
- `typ: "at+jwt"` (RFC 9068) accepts only access tokens: an id_token signed by
  the same keys is refused.
- `clockTolerance` allows a few seconds of drift between the two servers.

Answer a refused token with `401` and a `WWW-Authenticate` header (RFC 6750):

```ts
// docs/guide/examples/resource-server.ts
/** The `WWW-Authenticate` value of a refused token (RFC 6750). */
export const challenge = (
  error: "invalid_token" | "insufficient_scope",
  scope?: string,
) =>
  scope === undefined
    ? `Bearer error="${error}"`
    : `Bearer error="${error}", scope="${scope}"`;
```

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
    // A client_credentials token has the client id as `sub` (and as `client_id`).
    subject: {
      type: payload.sub === payload["client_id"] ? "client" : "user",
      id: payload.sub ?? "",
    },
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

A `client_credentials` token is a machine token: its `sub` is the client id (also
its `client_id`), and it has no `roles` or `permissions`. The mapper gives it the
subject type `client`, and its calls are decided on `scope` alone.

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
status to send: `403` `auth.errors.forbidden`, or `503` `limix.errors.unavailable`
(`401` `auth.errors.unauthenticated` only for an unauthenticated caller, which
this code never passes).

A token that fails verification is the caller's `401`; an issuer you cannot reach
is your `503`. `jose` errors carry a `code`, so the answer is chosen on it:

```ts
// docs/guide/examples/resource-server.ts
const REFUSED = [
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JOSE_ALG_NOT_ALLOWED",
];
const ISSUER_DOWN = [
  "ERR_JWKS_TIMEOUT",
  "ERR_JWKS_INVALID",
  "ERR_JOSE_GENERIC",
];

/** A token that fails verification is the caller's 401; an issuer you cannot reach is your 503. */
export function failure(error: unknown): Response {
  const code = error instanceof errors.JOSEError ? error.code : undefined;
  if (code !== undefined && REFUSED.includes(code)) {
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": challenge("invalid_token") },
    });
  }
  // A non-200 or non-JSON JWKS is ERR_JOSE_GENERIC; a network failure is a TypeError.
  if (
    (code !== undefined && ISSUER_DOWN.includes(code)) ||
    error instanceof TypeError
  ) {
    return new Response(null, { status: 503, headers: { "retry-after": "5" } });
  }
  throw error;
}
```

The first list in the snippet is the caller's fault: an expired token, a failed
issuer, audience or `typ` check, a bad signature, a malformed token, a token with
no `sub`, an unknown key or a disallowed algorithm. The second is the issuer's:
a JWKS request that timed out, answered a non-200 or non-JSON body, or failed on
the network. Any other jose code (`ERR_JOSE_NOT_SUPPORTED`,
`ERR_JWKS_MULTIPLE_MATCHING_KEYS`, `ERR_JWK_INVALID`) is rethrown on purpose and
becomes your server's own `500`.

The HTTP edge, with the answers:

```ts
// docs/guide/examples/resource-server.ts
/** The scope a request needs, mirroring the invoice rules; none for a rule decided on a role. */
export const scopeFor = (method: string, path: string) =>
  path.startsWith("/reports")
    ? undefined
    : method === "GET"
      ? "invoices:read"
      : method === "DELETE"
        ? "invoices:delete"
        : "invoices:write";

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
      if (decision.allow) return Response.json({ invoices: [] }); // your route runs here
      // The caller is signed in, so limix never answers 401 here: 403 or 503.
      const { code, status } = decision.refusal;
      return Response.json(
        { code },
        {
          status,
          headers:
            status === 403
              ? {
                  "www-authenticate": challenge(
                    "insufficient_scope",
                    scopeFor(request.method, new URL(request.url).pathname),
                  ),
                }
              : {},
        },
      );
    } catch (error) {
      return failure(error);
    }
  };
```

### An allowed call and a refused call

Say Alice holds a role granting `invoices:read` and `invoices:write` on the
Resource, and she asked for the three scopes `invoices:read invoices:write
invoices:delete`. Her token's `scope` holds the three, its `permissions` only two.

```sh
curl -i https://api.example/invoices -H "Authorization: Bearer $TOKEN"
```

```http
HTTP/1.1 200 OK
content-type: application/json

{"invoices":[]}
```

`invoices:delete` is in her `scope` but Clavix left it out of her `permissions`,
so your limix rule refuses it:

```sh
curl -i -X DELETE https://api.example/invoices/42 -H "Authorization: Bearer $TOKEN"
```

```http
HTTP/1.1 403 Forbidden
www-authenticate: Bearer error="insufficient_scope", scope="invoices:delete"
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
`@softistx/janus/permissions`. Clavix never receives your relations.

```ts
// docs/guide/examples/resource-server.ts
/** Step 6, relations: the janus model and store are yours (use your own store in production). */
export const model = defineModel({
  subjects: ["user", "client"],
  types: {
    invoice: { related: { owners: ["user"] }, permits: { view: ["owners"] } },
  },
});
export const access = permissions({ model, store: createMemoryRelations() });

/** A permission AND a relation: the caller may read this invoice only if they own it. */
export const ownedPolicy = compilePolicy(
  definePolicy({
    limix: 1,
    global: { unmatched: "deny" },
    rest: [
      {
        "GET /invoices/:id": {
          permissions: [["invoices:read"]],
          relations: [{ require: [[{ relation: "view", type: "invoice" }]] }],
        },
      } satisfies RestRulesInput,
    ],
  }),
);

// At start-up: a rule naming a type or relation the model lacks fails here, not per request.
export const modelIssues = checkModel(ownedPolicy, model);

export async function authorizeOwned(
  request: { method: string; path: string; token: string },
  keys: JWTVerifyGetKey,
  trust: Trust,
) {
  const claims = claimsOf(await verifyAccessToken(request.token, keys, trust));
  return evaluateRest(ownedPolicy, {
    method: request.method,
    path: request.path,
    claims,
    relations: janusRelations({ access }),
  });
}
```

The rule needs the permission and the relation: Alice reads invoice `42` once
she owns it (`access.grant({ type: "invoice", id: "42" }, "owners", { type: "user", id: "alice" })`),
and another invoice is a `404` (limix's default `onDeny`, so a caller cannot tell
it from a missing one). `checkModel` runs once at start-up and returns the rules
that name a type or relation the model lacks. The memory store above is for the
example; use your janus store. More in the
[limix-janus guide](https://github.com/softistx/limix/blob/develop/packages/limix-janus/docs/janus.md).

## 7. What is coming

Planned: the token's `scope` narrowed to the user's permissions, see [the roadmap](../roadmap.md#next).
