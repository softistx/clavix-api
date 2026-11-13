import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import type { Resolvers } from "@/generated/console/resolvers";
import {
  type ResendRefusal,
  ResendRefusedError,
} from "@/invitations/tenant-invitations";
import type { Audits } from "../../audit";
import type { ConsoleContext } from "../../context";
import { type Guards, onTenant } from "../../guard";
import type { Role } from "../../model";
import { activeTenant } from "../directory-tenant";
import { assertNotMember, changeRole, members, removeMember } from "./service";

const GRAPHQL_ROLE = {
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
} as const satisfies Record<Role, string>;
const ROLE_OF = { OWNER: "owner", ADMIN: "admin", VIEWER: "viewer" } as const;

// Lower-cased here as in `tenantIdOf`: the guard and the resolver act on the
// same id, whatever case the caller sent.
const tenantArg = (args: Record<string, unknown>) =>
  String(args["tenantId"]).toLowerCase();

// Reading the admins is `view`; changing them is `manage` (the tenant's owner,
// or a platform owner): an admin or a viewer cannot grant roles.
export const adminsGuards: Guards = {
  "Query.memberships": onTenant("view", tenantArg),
  "Query.adminInvitations": onTenant("view", tenantArg),
  "Mutation.inviteAdmin": onTenant("manage", tenantArg),
  "Mutation.changeMembership": onTenant("manage", tenantArg),
  "Mutation.removeMembership": onTenant("manage", tenantArg),
  "Mutation.revokeAdminInvitation": onTenant("manage", tenantArg),
  "Mutation.resendAdminInvitation": onTenant("manage", tenantArg),
};

// One event per mutation, recorded once its change is stored. A repeat records
// again (a removal of a non-member, a revocation of nothing): the retry of a
// call whose record failed must not leave the change with no event.
export const adminsAudits: Audits = {
  "Mutation.inviteAdmin": "membership.invite",
  "Mutation.changeMembership": "membership.change",
  "Mutation.removeMembership": "membership.remove",
  "Mutation.revokeAdminInvitation": "membership.revokeInvitation",
  "Mutation.resendAdminInvitation": "membership.resendInvitation",
};

// The guard decided who may touch the tenant; this decides the id has a
// tenant's form, in the one spelling the relations and the trail use.
function tenantIdOf(given: string) {
  if (!/^[0-9a-f]{24}$/i.test(given)) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return given.toLowerCase();
}

// An id the trail can name (an event's target id holds 200 characters at
// most): refused before anything is written, never after.
function targetId(given: string, name: string) {
  if (given.length === 0 || given.length > 200) {
    throw new GraphQLError(`${name} is not an id`, {
      extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
    });
  }
  return given;
}

const RESEND_STATUS = {
  NOT_FOUND: 404,
  INVITATION_NOT_PENDING: 409,
  RESEND_TOO_SOON: 429,
} as const satisfies Record<ResendRefusal, number>;

const RESEND_MESSAGE = {
  NOT_FOUND: "No such invitation",
  INVITATION_NOT_PENDING: "The invitation was accepted or revoked",
  RESEND_TOO_SOON: "The invitation was sent less than a minute ago",
} as const satisfies Record<ResendRefusal, string>;

// A resend's refusals as the contract's GraphQL errors.
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ResendRefusedError)) throw error;
    const { code, retryAfter } = error;
    throw new GraphQLError(RESEND_MESSAGE[code], {
      extensions: {
        code,
        http: {
          status: RESEND_STATUS[code],
          ...(retryAfter === undefined
            ? {}
            : { headers: { "retry-after": String(retryAfter) } }),
        },
        ...(retryAfter === undefined ? {} : { retryAfter }),
      },
    });
  }
}

// One resend of an invitation at a time (the cooldown check and the write).
const resendKey = (tenantId: string, invitationId: string) =>
  `console:resend:${tenantId}:${invitationId}`;

type StoredInvitation = Awaited<ReturnType<ConsoleContext["admins"]["invite"]>>;

// The inviter by id and display name (the name, else the e-mail): looked up
// once per distinct operator; an account that is gone has no name.
async function invitationsOf(
  ctx: Pick<ConsoleContext, "directory">,
  invitations: StoredInvitation[],
) {
  const names = new Map<string, string | null>();
  for (const { invitedBy } of invitations) {
    if (invitedBy === null || names.has(invitedBy)) continue;
    // A directory failure must not fail a read or a resend already done.
    const user = await ctx.directory.findUser(invitedBy).catch(() => null);
    names.set(invitedBy, user?.name ?? user?.email ?? null);
  }
  return invitations.map(({ invitedBy, ...invitation }) => ({
    ...invitation,
    role: GRAPHQL_ROLE[invitation.role],
    invitedBy:
      invitedBy === null
        ? null
        : { id: invitedBy, name: names.get(invitedBy) ?? null },
  }));
}

const memberOf = (
  user: { id: string; email: string; name?: string | undefined },
  role: Role,
) => ({
  user: { id: user.id, email: user.email, name: user.name ?? null },
  role: GRAPHQL_ROLE[role],
});

const one = async (
  ctx: Pick<ConsoleContext, "directory">,
  invitation: StoredInvitation,
) => {
  const [shaped] = await invitationsOf(ctx, [invitation]);
  if (shaped === undefined) throw new Error("an invitation went missing");
  return shaped;
};

export const admins: Resolvers = {
  Query: {
    // The guard lower-cased the id it checked; read with the same spelling.
    memberships: async (_, { tenantId }, ctx) =>
      (await members(ctx.access, ctx.directory, tenantIdOf(tenantId))).map(
        ({ user, role }) => memberOf(user, role),
      ),
    adminInvitations: async (_, { tenantId }, ctx) =>
      invitationsOf(ctx, await ctx.admins.invitations(tenantIdOf(tenantId))),
  },
  Mutation: {
    inviteAdmin: async (_, { tenantId: given, email, role }, ctx) => {
      const tenantId = tenantIdOf(given);
      const tenant = await activeTenant(ctx.directory, tenantId);
      const known = await ctx.directory.findUserByEmail(email);
      if (known !== null) await assertNotMember(ctx.access, tenantId, known.id);
      const inviter = await ctx.directory.findUser(ctx.principal.userId);
      const invitation = await ctx.admins.invite({
        tenantId,
        tenantName: tenant.name,
        email,
        role: ROLE_OF[role],
        invitedBy: {
          id: ctx.principal.userId,
          name: inviter?.name ?? inviter?.email,
        },
      });
      // The invitation's id, never the address or the code.
      await ctx.audit("membership.invite", {
        type: "invitation",
        id: invitation.id,
        tenantId,
      });
      return one(ctx, invitation);
    },
    changeMembership: async (_, { tenantId: given, userId, role }, ctx) => {
      const tenantId = tenantIdOf(given);
      targetId(userId, "userId");
      await activeTenant(ctx.directory, tenantId);
      // Before any write: a refusal leaves no change and no event.
      const user = await ctx.directory.findUser(userId);
      if (user === null) throw denial("NOT_FOUND", "No such user");
      const stored = await changeRole(ctx, tenantId, userId, ROLE_OF[role]);
      await ctx.audit("membership.change", {
        type: "user",
        id: userId,
        tenantId,
      });
      return memberOf(user, stored);
    },
    removeMembership: async (_, { tenantId: given, userId }, ctx) => {
      const tenantId = tenantIdOf(given);
      targetId(userId, "userId");
      // Like the other writes: a tenant that is gone or suspended is not edited.
      await activeTenant(ctx.directory, tenantId);
      await removeMember(ctx, tenantId, userId);
      await ctx.audit("membership.remove", {
        type: "user",
        id: userId,
        tenantId,
      });
      return true;
    },
    resendAdminInvitation: async (
      _,
      { tenantId: given, invitationId },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      targetId(invitationId, "invitationId");
      const tenant = await activeTenant(ctx.directory, tenantId);
      const sender = await ctx.directory.findUser(ctx.principal.userId);
      const resent = await ctx.exclusive(
        resendKey(tenantId, invitationId),
        () =>
          refusing(() =>
            ctx.admins.resend({
              tenantId,
              tenantName: tenant.name,
              invitationId,
              by: {
                id: ctx.principal.userId,
                name: sender?.name ?? sender?.email,
              },
            }),
          ),
      );
      // Recorded once the new code is out; a refusal stores nothing.
      await ctx.audit("membership.resendInvitation", {
        type: "invitation",
        id: invitationId,
        tenantId,
      });
      return one(ctx, resent);
    },
    revokeAdminInvitation: async (
      _,
      { tenantId: given, invitationId },
      ctx,
    ) => {
      const tenantId = tenantIdOf(given);
      targetId(invitationId, "invitationId");
      await ctx.admins.revoke(tenantId, invitationId);
      await ctx.audit("membership.revokeInvitation", {
        type: "invitation",
        id: invitationId,
        tenantId,
      });
      return true;
    },
  },
};
