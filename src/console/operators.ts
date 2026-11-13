import { CliInputError } from "@/cli/errors";
import type { Access } from "./access";
import type { Role } from "./model";

export const OPERATORS_USAGE = `Usage: bun run operators:grant --email <address> [--role owner|admin|viewer] [--create]

Grants a user of the clavix tenant a platform role (default: owner), so they
manage every tenant in the console. Idempotent.

Without --create the user must already exist in the clavix tenant. With
--create, an address with no user is invited instead: the clavix tenant mails
an invitation link, and the account is made, with the role, when they accept
it. Re-running resends the invitation. Use it on a fresh database, where the
tenant is invitation-only and has no user yet.`;

export function parseOperatorArgs(args: readonly string[]): {
  email: string;
  role: Role;
  create: boolean;
} {
  let create = false;
  let email: string | undefined;
  let role: Role = "owner";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--create") {
      create = true;
    } else if (flag === "--email" && value !== undefined) {
      email = value;
      i++;
    } else if (flag === "--role" && value !== undefined) {
      if (value !== "owner" && value !== "admin" && value !== "viewer") {
        throw new CliInputError(`--role must be owner, admin or viewer`);
      }
      role = value;
      i++;
    } else {
      throw new CliInputError(`unknown or incomplete argument "${flag}"`);
    }
  }
  if (email === undefined || email.trim() === "") {
    throw new CliInputError("--email is required");
  }
  return { email: email.trim(), role, create };
}

export type OperatorGrant =
  | { userId: string; email: string; role: Role }
  | { invitationId: string; email: string; role: Role; invited: true };

/**
 * Grants a platform role to the user of the `clavix` tenant with this e-mail
 * and records it as the admin event `operator.grant`. An address with no user
 * is refused, unless `create`: it is then invited (the e-mail goes out through
 * the tenant's mail path), and accepting the invitation makes the account and
 * grants the role (`adminInvitationHooks`). Idempotent either way.
 */
export async function grantOperator(
  deps: {
    findByEmail(email: string): Promise<{ id: string; email: string } | null>;
    access: Pick<Access, "grantPlatform">;
    /** Issues and mails the operator invitation; the id of the invitation. */
    invite(email: string, role: Role): Promise<{ id: string }>;
    record(target: { type: string; id: string }): Promise<void>;
  },
  input: { email: string; role: Role; create: boolean },
): Promise<OperatorGrant> {
  const user = await deps.findByEmail(input.email);
  if (user === null) {
    if (!input.create) {
      throw new CliInputError(
        `no user with e-mail "${input.email}" in the clavix tenant: re-run with --create to invite them`,
      );
    }
    const invitation = await deps.invite(input.email, input.role);
    await deps.record({ type: "invitation", id: invitation.id });
    return {
      invitationId: invitation.id,
      email: input.email,
      role: input.role,
      invited: true,
    };
  }
  await deps.access.grantPlatform(user.id, input.role);
  await deps.record({ type: "user", id: user.id });
  return { userId: user.id, email: user.email, role: input.role };
}
