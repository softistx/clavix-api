import { JanusError } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";
import { adminTenantOf } from "@/modules/invitations/scope";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { fail } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";

const invalid = () =>
  fail("INVITATION_INVALID", "The invitation is invalid or has expired", {
    status: 400,
  });

// Every refusal alike, so a code cannot be told apart from a spent one.
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof JanusError && error.code !== "STORE_FAILED") {
      throw invalid();
    }
    throw error;
  }
}

// The janus instance and the tenant of the request's host.
async function tenantOf(ctx: Context) {
  const [auth, tenant] = await Promise.all([
    janusIssuers.forRequest(ctx.request),
    ctx.tenant(),
  ]);
  if (auth === null || tenant === null) {
    throw denial("NOT_FOUND", "No such tenant");
  }
  return { auth, tenant };
}

/**
 * What the invitee joins: the tenant they will administer for an admin
 * invitation (gone or suspended: the invitation is invalid), else the tenant
 * of the host, whose user pool they enter.
 */
async function organizationOf(
  scope: string,
  host: { name: string; slug: string },
) {
  // An admin scope only has that meaning where admins are invited: on `clavix`.
  const managed =
    host.slug === PLATFORM_TENANT_SLUG ? adminTenantOf(scope) : null;
  if (managed === null) return host.name;
  const [tenant] = await tenantsService.activeByIds([managed]);
  if (tenant === undefined) throw invalid();
  return tenant.name;
}

export const invitations: Resolvers = {
  Query: {
    invitationPreview: async (_, { code }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      ctx.set.headers.set("cache-control", "no-store");
      const preview = await guarded(() => auth.invitations.preview(code));
      return {
        email: preview.email,
        organization: await organizationOf(preview.scope, tenant),
        role: preview.role,
        expiresAt: preview.expiresAt,
      };
    },
  },
  Mutation: {
    acceptInvitation: async (_, { code }, ctx) => {
      const { auth, tenant } = await tenantOf(ctx);
      requireLive(tenant);
      ctx.set.headers.set("cache-control", "no-store");
      const accepted = await guarded(() => auth.invitations.accept({ code }));
      const organization = await organizationOf(
        accepted.invitation.scope,
        tenant,
      ).catch((error: unknown) => {
        // Accepted already: a tenant gone since is no refusal.
        if (error instanceof GraphQLError) return "";
        throw error;
      });
      if (accepted.status === "signedIn") {
        ctx.set.headers.append(
          "set-cookie",
          auth.cookie.serialize(accepted.token, accepted.session),
        );
        const user = await auth.findUser(accepted.user.id);
        if (user === null) throw invalid();
        // The sign-in counts as the month's activity, like any other sign-in.
        await usageService.recordActive(tenant.tenantId, user.id);
        return {
          signedIn: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name ?? null,
            emailVerified: user.emailVerified,
          },
          expiresAt: accepted.session.expiresAt,
          organization,
        };
      }
      // The address already had an account (they sign in as usual).
      return { signedIn: false, user: null, expiresAt: null, organization };
    },
  },
};
