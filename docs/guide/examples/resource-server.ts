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

/** What the resource server knows about Clavix: the tenant's issuer and its own Resource URI. */
export interface Trust {
  /** The tenant's issuer, e.g. `https://acme.clavix.example` (no trailing slash). */
  issuer: string;
  /** The Resource's `uri` in Clavix: the `aud` every accepted token carries. */
  resource: string;
}

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

/** The keys of the issuer: fetched on demand, cached, and refetched when a `kid` is unknown. */
export const remoteKeys = (jwksUri: string): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(jwksUri));

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

/** The `WWW-Authenticate` value of a refused token (RFC 6750). */
export const challenge = (error: "invalid_token" | "insufficient_scope") =>
  `Bearer error="${error}"`;

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
