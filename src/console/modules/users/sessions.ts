import type { Resolvers } from "@/generated/console/resolvers";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { activeTenant, idArg, tenantArg, tenantIdOf } from "../ids";

// A user's sessions: read is `view`, ending one is `edit`.
const target = (type: string, id: string, tenantId: string) => ({
  type,
  id,
  tenantId,
});

export const sessionsGuards: Guards = {
  "Query.userSessions": onTenant("view", tenantArg),
  "Mutation.revokeUserSession": onTenant("edit", tenantArg),
};

export const sessionsAudits: Audits = {
  "Mutation.revokeUserSession": "user.revokeSession",
};

export const sessions: Resolvers = {
  Query: {
    userSessions: async (_, { tenantId: given, userId }, ctx) => {
      const tenantId = tenantIdOf(given);
      await activeTenant(ctx.directory, tenantId);
      return (await ctx.users.sessions(tenantId, userId)).map((session) => ({
        ...session,
        device: session.device ?? null,
        lastUsedAt: session.lastUsedAt ?? null,
      }));
    },
  },
  Mutation: {
    revokeUserSession: async (
      _,
      { tenantId: given, userId, sessionId },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      idArg(userId, "userId");
      idArg(sessionId, "sessionId");
      await activeTenant(ctx.directory, tenantId);
      const ended = await ctx.users.revokeSession(tenantId, userId, sessionId);
      // Recorded on a repeat and on a session that is not this user's too:
      // the id is only named, never read.
      await ctx.audit(
        "user.revokeSession",
        target("session", sessionId, tenantId),
      );
      return ended;
    },
  },
};
