import type { Claims } from "@softistx/limix";
import { consoleContextOf } from "@/console/context";
import { callerProved } from "@/console/guard";
import type { Permission } from "@/console/model";
import { isContext } from "@/http/context";

/**
 * Who calls the console API: the user of the accepted token, and the
 * platform check the conditions ask (`conditions.ts`). The plugin has
 * verified the token before any field runs.
 */
export const consoleClaims = (ctx: object): Claims => {
  const console = consoleContextOf(ctx);
  return {
    authenticated: true,
    subject: { type: "user", id: console.principal.userId },
    // An unproved e-mail is answered first by the field guard (EMAIL_UNVERIFIED,
    // ADR-0041): the rules defer to it rather than word it FORBIDDEN.
    platform: async (permission: Permission) =>
      !(await callerProved(console)) || console.canPlatform(permission),
  };
};

/**
 * Who calls the hosted API: the signed-in user of the request's session, none
 * when anonymous. A host that names no tenant is anonymous here: the
 * resolvers answer it (404) themselves.
 */
export const hostedClaims = async (ctx: object): Promise<Claims> => {
  if (!isContext(ctx)) return { authenticated: false };
  // A session read that fails counts as anonymous (401): the resolvers' own checks answer an outage.
  const user = await ctx.janus.user().catch(() => null);
  return user === null
    ? { authenticated: false }
    : { authenticated: true, subject: { type: "user", id: user.id } };
};
