import { JanusError } from "@softistx/janus";
import type { OAuthGrants } from "@softistx/janus-oauth";
import type {
  ConsoleUsers,
  TenantUserView,
  UserSecondFactorView,
} from "@/console/context";
import { TenantUnavailableError, userScope } from "@/modules/invitations";
import { removePicture } from "@/modules/media/media.utils";
import {
  type ProfileChanges,
  patchOf,
  refuse,
  refuseCommon,
} from "@/modules/profile";
import { gone } from "./users.errors";
import type { TenantJanus } from "./users.tenant-janus";
import type { UsersSource } from "./users.types";
import { view } from "./users.utils";

const NO_FACTOR: UserSecondFactorView = {
  enabled: false,
  recoveryCodesLeft: null,
};

/** The console's users of every tenant (`ConsoleUsers`), over each tenant's janus instance and OAuth server. */
export class UsersService implements ConsoleUsers {
  constructor(private readonly source: UsersSource) {}

  /** A tenant's pool, "not found" once the tenant is gone. */
  private async janus(tenantId: string): Promise<TenantJanus> {
    const found = await this.source.janusOf(tenantId);
    if (found === null) throw gone();
    return found;
  }

  /** A tenant's OAuth grants, "not found" once the tenant is gone. */
  private async grantsOf(tenantId: string): Promise<OAuthGrants> {
    const found = await this.source.grantsOf(tenantId);
    if (found === null) throw gone();
    return found;
  }

  /** Runs an invitation call, a tenant that went away mid-request being "not found". */
  private async invitingly<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof TenantUnavailableError) throw gone();
      throw error;
    }
  }

  /** Runs a write on a user, a user gone meanwhile being `null`. */
  private async writing(
    tenantId: string,
    id: string,
    write: (
      auth: TenantJanus,
      user: NonNullable<Awaited<ReturnType<TenantJanus["findUser"]>>>,
    ) => Promise<TenantUserView>,
  ): Promise<TenantUserView | null> {
    const auth = await this.janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return null;
    try {
      return await write(auth, user);
    } catch (error) {
      if (error instanceof JanusError && error.code === "NOT_FOUND") {
        return null;
      }
      if (error instanceof JanusError && error.code === "VERSION_CONFLICT") {
        refuseCommon(
          "CONFLICT",
          "The user changed meanwhile; read it and try again",
        );
      }
      throw error;
    }
  }

  async list(
    tenantId: string,
    page: { after: string | null; limit: number; emailPrefix?: string },
  ) {
    const { after, limit, emailPrefix } = page;
    const found = await (await this.janus(tenantId)).list({
      after,
      limit,
      ...(emailPrefix === undefined ? {} : { emailPrefix }),
    });
    return { items: found.items.map(view), nextCursor: found.nextCursor };
  }

  async count(tenantId: string, filter: { emailPrefix?: string } = {}) {
    return (await this.janus(tenantId)).count(
      filter.emailPrefix === undefined
        ? {}
        : { emailPrefix: filter.emailPrefix },
    );
  }

  async lookup(tenantId: string, query: string, limit: number) {
    const auth = await this.janus(tenantId);
    const found = new Map<string, TenantUserView>();
    const logins = await auth.list({ limit, emailPrefix: query });
    for (const user of logins.items) found.set(user.id, view(user));
    if (query.trim() !== "" && found.size < limit) {
      const names = await auth.list({
        limit: limit + found.size,
        namePrefix: query,
      });
      for (const user of names.items) {
        if (found.size >= limit) break;
        found.set(user.id, view(user));
      }
    }
    return [...found.values()].slice(0, limit);
  }

  async find(tenantId: string, id: string) {
    const user = await (await this.janus(tenantId)).findUser(id);
    return user === null ? null : view(user);
  }

  async findMany(tenantId: string, ids: readonly string[]) {
    const found = new Map(
      (await (await this.janus(tenantId)).findMany([...ids])).map((user) => [
        user.id,
        view(user),
      ]),
    );
    return ids.map((id) => found.get(id) ?? null);
  }

  async findByEmail(tenantId: string, email: string) {
    const user = await (await this.janus(tenantId)).findByEmail(email);
    return user === null ? null : view(user);
  }

  setEmailVerified(tenantId: string, id: string, verified: boolean) {
    return this.writing(tenantId, id, async (auth, user) =>
      view(await auth.setEmailVerified(user, verified)),
    );
  }

  setActive(tenantId: string, id: string, active: boolean) {
    return this.writing(tenantId, id, async (auth, user) => {
      const written =
        user.active === active ? user : await auth.setActive(user, active);
      // A disabled user keeps no session: ended on a repeat too.
      if (!active) await auth.signOutEverywhere(user.id);
      return view(written);
    });
  }

  update(tenantId: string, id: string, changes: ProfileChanges) {
    return this.writing(tenantId, id, async (auth, user) => {
      const patch = patchOf(changes, user);
      if (Object.keys(patch).length === 0) return view(user);
      return view(await auth.update(user, patch, { ifVersion: user.version }));
    });
  }

  setPhoneVerified(tenantId: string, id: string, verified: boolean) {
    return this.writing(tenantId, id, async (auth, user) => {
      if (user.phone === null || user.phone === undefined) {
        refuse(
          "PROFILE_FIELD_INVALID",
          "The user has no phone number",
          "phone",
        );
      }
      if (user.phone.verified === verified) return view(user);
      const phone = { number: user.phone.number, verified };
      return view(
        await auth.update(user, { phone }, { ifVersion: user.version }),
      );
    });
  }

  async removePicture(tenantId: string, id: string) {
    const auth = await this.janus(tenantId);
    if ((await auth.findUser(id)) === null) return null;
    try {
      return await removePicture({ tenantId, userId: id, auth });
    } catch (error) {
      if (error instanceof JanusError && error.code === "NOT_FOUND") {
        return null;
      }
      if (error instanceof JanusError && error.code === "VERSION_CONFLICT") {
        refuseCommon(
          "CONFLICT",
          "The user changed meanwhile; read it and try again",
        );
      }
      throw error;
    }
  }

  async delete(tenantId: string, id: string) {
    const auth = await this.janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return false;
    // Grants and their tokens first: a failure here leaves the user to retry.
    await (await this.grantsOf(tenantId)).revokeAll({ id });
    await auth.signOutEverywhere(id);
    return auth.delete(user);
  }

  async secondFactor(tenantId: string, id: string) {
    const auth = await this.janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return NO_FACTOR;
    return {
      enabled: user.hasSecondFactor === true,
      recoveryCodesLeft: await auth.secondFactor.recoveryCodesLeft(user),
    };
  }

  async secondFactors(tenantId: string, ids: readonly string[]) {
    const auth = await this.janus(tenantId);
    const found = new Map(
      (await auth.findMany([...ids])).map((user) => [user.id, user]),
    );
    // janus counts the recovery codes one user at a time and answers `null`
    // without an active factor: only the holders' are read.
    return Promise.all(
      ids.map(async (id) => {
        const user = found.get(id);
        if (user?.hasSecondFactor !== true) return NO_FACTOR;
        return {
          enabled: true,
          recoveryCodesLeft: await auth.secondFactor.recoveryCodesLeft(user),
        };
      }),
    );
  }

  async resetSecondFactor(tenantId: string, id: string) {
    const auth = await this.janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return null;
    await auth.secondFactor.disable(user);
    return view((await auth.findUser(id)) ?? user);
  }

  async sessions(tenantId: string, id: string) {
    const auth = await this.janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return [];
    return (await auth.sessions.list(user)).map(
      ({ id, device, createdAt, authenticatedAt, lastUsedAt, expiresAt }) => ({
        id,
        device,
        createdAt,
        authenticatedAt,
        lastUsedAt,
        expiresAt,
      }),
    );
  }

  async revokeSession(tenantId: string, id: string, sessionId: string) {
    const auth = await this.janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return false;
    return auth.sessions.revoke(user, sessionId);
  }

  async revokeSessions(tenantId: string, id: string) {
    const auth = await this.janus(tenantId);
    if ((await auth.findUser(id)) === null) return 0;
    return auth.signOutEverywhere(id);
  }

  async invite(input: Parameters<ConsoleUsers["invite"]>[0]) {
    const { tenantId, tenantName, email, invitedBy } = input;
    const invitation = await this.invitingly(() =>
      this.source.invitationsOf(tenantId).invite({
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
  }

  async invitations(tenantId: string) {
    const pending = await this.invitingly(() =>
      this.source.invitationsOf(tenantId).pending(userScope()),
    );
    return pending.map(({ id, email, invitedAt, expiresAt }) => ({
      id,
      email,
      invitedAt,
      expiresAt,
    }));
  }

  revokeInvitation(tenantId: string, invitationId: string) {
    return this.invitingly(() =>
      this.source.invitationsOf(tenantId).revoke(userScope(), invitationId),
    );
  }

  async grants(tenantId: string, userId: string) {
    return [...(await (await this.grantsOf(tenantId)).list({ id: userId }))];
  }

  async revokeGrant(tenantId: string, userId: string, grantId: string) {
    return (await this.grantsOf(tenantId)).revoke({ id: userId }, grantId);
  }
}
