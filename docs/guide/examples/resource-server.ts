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

/** The keys of the issuer: fetched on demand, cached, and refetched when a `kid` is unknown. */
export const remoteKeys = (
  jwksUri: string,
  fetcher?: Fetcher,
): JWTVerifyGetKey =>
  createRemoteJWKSet(
    new URL(jwksUri),
    fetcher === undefined ? {} : { [customFetch]: (url) => fetcher(url) },
  );

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

/** The `WWW-Authenticate` value of a refused token (RFC 6750). */
export const challenge = (
  error: "invalid_token" | "insufficient_scope",
  scope?: string,
) =>
  scope === undefined
    ? `Bearer error="${error}"`
    : `Bearer error="${error}", scope="${scope}"`;

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

/** The scope a method needs on this API, as the rules above say (for the `scope` of the challenge). */
const scopeFor = (method: string) =>
  method === "GET"
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
                    scopeFor(request.method),
                  ),
                }
              : {},
        },
      );
    } catch (error) {
      return failure(error);
    }
  };

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
