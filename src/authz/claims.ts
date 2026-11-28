import type { Claims } from "@softistx/limix";
import { consoleContextOf } from "@/console/context";
import { callerProved } from "@/console/guard";
import type { Permission } from "@/console/model";
import { contextOf } from "@/http/context";

/**
 * Who calls the console API: the user and the scopes of the accepted token,
 * and the platform check the conditions ask (`conditions.ts`). No `roles` claim:
 * an operator's roles are ReBAC relations, asked on demand through the relations
 * port (`relations.ts`) and the platform check, never listed in the token. The plugin has
 * verified the token before any field runs.
 */
export const consoleClaims = (ctx: object): Claims => {
  const console = consoleContextOf(ctx);
  return {
    authenticated: true,
    subject: { type: "user", id: console.principal.userId },
    // The token's scopes: the rules' `permissions` read them (every console rule asks `console`).
    scope: console.principal.scopes.join(" "),
    // An unproved e-mail is answered first by the field guard (EMAIL_UNVERIFIED,
    // ADR-0041): the rules defer to it rather than word it FORBIDDEN.
    platform: async (permission: Permission) =>
      !(await callerProved(console)) || console.canPlatform(permission),
  };
};

/**
 * Who calls the hosted API: the signed-in user of the request's session, none
 * when anonymous. Only an anonymous caller is "not signed in". A failure of the
 * session read (a host that names no active tenant answers NOT_FOUND, janus's
 * `auth`, `auth.plugin.ts`; a janus outage) is never read as anonymous: it is
 * held and thrown when a rule asks `authenticated`, so the fields that need the
 * caller answer it as before (404, or limix 503 / the masked reported error)
 * while a public field, which asks nothing, is still served.
 */
export const hostedClaims = async (ctx: object): Promise<Claims> => {
  try {
    const user = await contextOf(ctx).janus.user();
    return user === null
      ? { authenticated: false }
      : { authenticated: true, subject: { type: "user", id: user.id } };
  } catch (failure) {
    return {
      get authenticated(): boolean {
        throw failure;
      },
    };
  }
};
