import { CliInputError } from "@/cli/errors";
import { operatorScope } from "@/invitations/scope";
import type { TenantInvitations } from "@/invitations/tenant-invitations";
import type { Access } from "./access";
import type { AdminEventRecorder } from "./admin-events/recorder";
import type { Role } from "./model";

export const OPERATORS_USAGE = `Usage: bun run operators:grant --email <address> [--role owner|admin|viewer] [--create]

Grants a user of the clavix tenant a platform role (default: owner), so they
manage every tenant in the console. A disabled account is refused. Idempotent.

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
 * grants the role (`adminInvitationHooks`). A disabled account is refused.
 * Idempotent either way.
 */
export async function grantOperator(
  deps: {
    findByEmail(
      email: string,
    ): Promise<{ id: string; email: string; active: boolean } | null>;
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
  if (!user.active) {
    throw new CliInputError(
      `the account "${input.email}" is disabled: enable it before granting a platform role`,
    );
  }
  await deps.access.grantPlatform(user.id, input.role);
  await deps.record({ type: "user", id: user.id });
  return { userId: user.id, email: user.email, role: input.role };
}

type GrantDeps = Parameters<typeof grantOperator>[0];

/**
 * The script's wiring: the operator invitation (operator scope, issued by the
 * system for "Clavix") and the `operator.grant` admin event (platform target,
 * no tenant, actor `cli:operators:grant`).
 */
export function operatorGrantDeps(parts: {
  findByEmail: GrantDeps["findByEmail"];
  access: GrantDeps["access"];
  invitations: Pick<TenantInvitations, "invite">;
  recorder: Pick<AdminEventRecorder, "record">;
}): GrantDeps {
  return {
    findByEmail: parts.findByEmail,
    access: parts.access,
    invite: (email, role) =>
      parts.invitations.invite({
        scope: operatorScope(),
        organization: "Clavix",
        email,
        role,
        invitedBy: null,
      }),
    record: async (target) => {
      await parts.recorder.record({
        actor: "cli:operators:grant",
        action: "operator.grant",
        tenantId: null,
        target,
        requestId: crypto.randomUUID(),
      });
    },
  };
}
