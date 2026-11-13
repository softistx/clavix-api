import { JanusError } from "@softistx/janus";
import { denial } from "@softistx/janus-graphql";
import { GraphQLError } from "graphql";
import { tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import type { Resolvers } from "@/generated/graphql/resolvers";
import type { Context } from "@/http/context";

const invalid = () =>
  new GraphQLError("The invitation is invalid or has expired", {
    extensions: { code: "INVITATION_INVALID", http: { status: 400 } },
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

async function authOf(ctx: Context) {
  const auth = await janusIssuers.forRequest(ctx.request);
  if (auth === null) throw denial("NOT_FOUND", "No such tenant");
  return auth;
}

/** The scope of an invitation is the id of the tenant it is for; its name is the organization. */
async function organizationOf(scope: string): Promise<string> {
  const [tenant] = await tenantsService.activeByIds([scope]);
  return tenant?.name ?? "";
}

export const invitations: Resolvers = {
  Query: {
    invitationPreview: async (_, { code }, ctx) => {
      const auth = await authOf(ctx);
      ctx.set.headers.set("cache-control", "no-store");
      const preview = await guarded(() => auth.invitations.preview(code));
      return {
        email: preview.email,
        organization: await organizationOf(preview.scope),
        role: preview.role,
        expiresAt: preview.expiresAt,
      };
    },
  },
  Mutation: {
    acceptInvitation: async (_, { code }, ctx) => {
      const auth = await authOf(ctx);
      ctx.set.headers.set("cache-control", "no-store");
      const accepted = await guarded(() => auth.invitations.accept({ code }));
      const organization = await organizationOf(accepted.invitation.scope);
      if (accepted.status === "signedIn") {
        ctx.set.headers.append(
          "set-cookie",
          auth.cookie.serialize(accepted.token, accepted.session),
        );
        const user = await auth.findUser(accepted.user.id);
        if (user === null) throw invalid();
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
