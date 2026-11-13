import { JanusError } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import type { OAuthGrants } from "@softistx/janus-oauth";
import { userScope } from "@/invitations/scope";
import {
  type TenantInvitations,
  TenantUnavailableError,
} from "@/invitations/tenant-invitations";
import type { TenantJanus } from "@/users/tenant-janus";
import type { ConsoleUsers, TenantUserView } from "../../context";

/** Where `ConsoleUsers` reaches a tenant's pool; `null` for a tenant that is gone or suspended. */
export interface UsersSource {
  janusOf(tenantId: string): Promise<TenantJanus | null>;
  grantsOf(tenantId: string): Promise<OAuthGrants | null>;
  invitationsOf(tenantId: string): TenantInvitations;
}

// A tenant suspended or deleted since the resolver checked it: not found, as
// for any other call that names it.
const gone = () => denial("NOT_FOUND", "No such tenant");

/** Runs an invitation call, a tenant that went away mid-request being "not found". */
async function invitingly<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TenantUnavailableError) throw gone();
    throw error;
  }
}

type PoolUser = NonNullable<Awaited<ReturnType<TenantJanus["findUser"]>>>;

const view = (user: PoolUser): TenantUserView => ({
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerified,
  active: user.active,
  createdAt: user.createdAt,
});

/** `ConsoleUsers` over each tenant's janus instance and OAuth server. */
export function createJanusUsers(source: UsersSource): ConsoleUsers {
  const janus = async (tenantId: string) => {
    const found = await source.janusOf(tenantId);
    if (found === null) throw gone();
    return found;
  };
  const grants = async (tenantId: string) => {
    const found = await source.grantsOf(tenantId);
    if (found === null) throw gone();
    return found;
  };
  return {
    async list(tenantId, { after, limit, emailPrefix }) {
      const page = await (await janus(tenantId)).list({
        after,
        limit,
        ...(emailPrefix === undefined ? {} : { emailPrefix }),
      });
      return { items: page.items.map(view), nextCursor: page.nextCursor };
    },
    async count(tenantId, { emailPrefix } = {}) {
      return (await janus(tenantId)).count(
        emailPrefix === undefined ? {} : { emailPrefix },
      );
    },
    async setEmailVerified(tenantId, id, verified) {
      const auth = await janus(tenantId);
      const user = await auth.findUser(id);
      if (user === null) return null;
      try {
        return view(await auth.setEmailVerified(user, verified));
      } catch (error) {
        if (error instanceof JanusError && error.code === "NOT_FOUND")
          return null;
        throw error;
      }
    },
    async sessions(tenantId, id) {
      const auth = await janus(tenantId);
      const user = await auth.findUser(id);
      if (user === null) return [];
      return (await auth.sessions.list(user)).map(
        ({
          id,
          device,
          createdAt,
          authenticatedAt,
          lastUsedAt,
          expiresAt,
        }) => ({
          id,
          device,
          createdAt,
          authenticatedAt,
          lastUsedAt,
          expiresAt,
        }),
      );
    },
    async revokeSession(tenantId, id, sessionId) {
      const auth = await janus(tenantId);
      const user = await auth.findUser(id);
      if (user === null) return false;
      return auth.sessions.revoke(user, sessionId);
    },
    async find(tenantId, id) {
      const user = await (await janus(tenantId)).findUser(id);
      return user === null ? null : view(user);
    },
    async findByEmail(tenantId, email) {
      const user = await (await janus(tenantId)).findByEmail(email);
      return user === null ? null : view(user);
    },
    async setActive(tenantId, id, active) {
      const auth = await janus(tenantId);
      const user = await auth.findUser(id);
      if (user === null) return null;
      try {
        const written =
          user.active === active ? user : await auth.setActive(user, active);
        // A disabled user keeps no session: ended on a repeat too.
        if (!active) await auth.signOutEverywhere(user.id);
        return view(written);
      } catch (error) {
        if (error instanceof JanusError && error.code === "NOT_FOUND")
          return null;
        throw error;
      }
    },
    async rename(tenantId, id, name) {
      const auth = await janus(tenantId);
      const user = await auth.findUser(id);
      if (user === null) return null;
      try {
        return view(
          user.name === name ? user : await auth.update(user, { name }),
        );
      } catch (error) {
        if (error instanceof JanusError && error.code === "NOT_FOUND")
          return null;
        throw error;
      }
    },
    async revokeSessions(tenantId, id) {
      const auth = await janus(tenantId);
      if ((await auth.findUser(id)) === null) return 0;
      return auth.signOutEverywhere(id);
    },
    async delete(tenantId, id) {
      const auth = await janus(tenantId);
      const user = await auth.findUser(id);
      if (user === null) return false;
      // Grants and their tokens first: a failure here leaves the user to retry.
      await (await grants(tenantId)).revokeAll({ id });
      await auth.signOutEverywhere(id);
      return auth.delete(user);
    },
    async invite({ tenantId, tenantName, email, invitedBy }) {
      const invitation = await invitingly(() =>
        source.invitationsOf(tenantId).invite({
          scope: userScope(),
          organization: tenantName,
          email,
          role: "user",
          invitedBy,
        }),
      );
      return {
        id: invitation.id,
        email: invitation.email,
        invitedAt: invitation.invitedAt,
        expiresAt: invitation.expiresAt,
      };
    },
    async invitations(tenantId) {
      const pending = await invitingly(() =>
        source.invitationsOf(tenantId).pending(userScope()),
      );
      return pending.map(({ id, email, invitedAt, expiresAt }) => ({
        id,
        email,
        invitedAt,
        expiresAt,
      }));
    },
    revokeInvitation: (tenantId, invitationId) =>
      invitingly(() =>
        source.invitationsOf(tenantId).revoke(userScope(), invitationId),
      ),
    async grants(tenantId, userId) {
      return [...(await (await grants(tenantId)).list({ id: userId }))];
    },
    async revokeGrant(tenantId, userId, grantId) {
      return (await grants(tenantId)).revoke({ id: userId }, grantId);
    },
  };
}
