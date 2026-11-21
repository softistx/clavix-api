import type { ConsoleContext } from "@/console/context";
import { shapeInvitation } from "./admins.utils";

type StoredInvitation = Awaited<ReturnType<ConsoleContext["admins"]["invite"]>>;

/**
 * The invitations with the inviter by id and display name (the name, else the
 * e-mail): looked up once per distinct operator; an account that is gone has
 * no name.
 */
export async function invitationsOf(
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
  return invitations.map((invitation) => shapeInvitation(invitation, names));
}

/** One invitation, shaped like the list's. */
export const one = async (
  ctx: Pick<ConsoleContext, "directory">,
  invitation: StoredInvitation,
) => {
  const [shaped] = await invitationsOf(ctx, [invitation]);
  if (shaped === undefined) throw new Error("an invitation went missing");
  return shaped;
};
