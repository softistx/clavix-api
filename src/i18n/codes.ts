import { codes as console } from "@/console/console.errors";
import { codes as attributes } from "@/modules/attributes";
import { codes as auth } from "@/modules/auth/auth.errors";
import { codes as branding } from "@/modules/branding";
import { codes as connections } from "@/modules/connections/connections.errors";
import { codes as consent } from "@/modules/consent/consent.errors";
import { codes as domains } from "@/modules/domains";
import { codes as invitations } from "@/modules/invitations/invitations.errors";
import { codes as mfa } from "@/modules/mfa/mfa.errors";
import { codes as passkeys } from "@/modules/passkeys/passkeys.errors";
import { codes as resources } from "@/modules/resources";
import { codes as roles } from "@/modules/roles";
import { codes as signInMethods } from "@/modules/sign-in-methods";
import { codes as tenants } from "@/modules/tenants";
import { defineCodes } from "./define-codes";

// Answers every module gives alike, so declared here.
export const common = defineCodes("common", [
  "BAD_USER_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "METHOD_NOT_ALLOWED",
]);

// Every module's declaration, in module order.
export const groups = [
  common,
  attributes,
  auth,
  branding,
  connections,
  consent,
  console,
  domains,
  invitations,
  mfa,
  passkeys,
  resources,
  roles,
  signInMethods,
  tenants,
] as const;

// Every code the API answers with: the inventory. tsc refuses a code that is
// not in it (`fail`), and the codes spec requires each to be declared once.
export const errorCodes = groups.flatMap((group) => group.codes);

export type ErrorCode = (typeof groups)[number]["codes"][number];
