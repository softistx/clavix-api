import { CliInputError } from "@/cli/errors";
import type { Access } from "./access";
import type { Role } from "./model";

export const OPERATORS_USAGE = `Usage: bun run operators:grant --email <address> [--role owner|admin|viewer]

Grants a user of the clavix tenant a platform role (default: owner), so they
manage every tenant in the console. The user must already exist in the clavix
tenant (sign in once, or have been invited). Idempotent.`;

export function parseOperatorArgs(args: readonly string[]): {
  email: string;
  role: Role;
} {
  let email: string | undefined;
  let role: Role = "owner";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--email" && value !== undefined) {
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
  return { email: email.trim(), role };
}

/**
 * Grants a platform role to the user of the `clavix` tenant with this e-mail.
 * Answers the user; an unknown address is refused (the script never creates a
 * user).
 */
export async function grantOperator(
  deps: {
    findByEmail(email: string): Promise<{ id: string; email: string } | null>;
    access: Pick<Access, "grantPlatform">;
  },
  input: { email: string; role: Role },
): Promise<{ userId: string; email: string; role: Role }> {
  const user = await deps.findByEmail(input.email);
  if (user === null) {
    throw new CliInputError(
      `no user with e-mail "${input.email}" in the clavix tenant: have them sign in to the console tenant once, or invite them`,
    );
  }
  await deps.access.grantPlatform(user.id, input.role);
  return { userId: user.id, email: user.email, role: input.role };
}
