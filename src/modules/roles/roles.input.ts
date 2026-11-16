import { RolesError } from "./roles.errors";

const NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_DESCRIPTION = 300;
export const MAX_ID = 200;

export function refuse(code: RolesError["code"], message: string): never {
  throw new RolesError(code, message);
}

export function cleanName(name: string) {
  const clean = name.trim();
  if (!NAME.test(clean)) {
    refuse(
      "BAD_USER_INPUT",
      "a role name is 1 to 64 characters of letters, digits, '.', '_', ':' and '-'",
    );
  }
  return clean;
}

export function cleanDescription(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (clean.length > MAX_DESCRIPTION) {
    refuse(
      "BAD_USER_INPUT",
      `a description has at most ${MAX_DESCRIPTION} characters`,
    );
  }
  return clean;
}

export const managedRefusal = (name: string) =>
  new RolesError(
    "ROLE_MANAGED",
    `The role "${name}" is managed by Clavix and cannot be changed or deleted`,
  );

export const conflict = (name: string) =>
  new RolesError("CONFLICT", `A role named "${name}" already exists here`);
