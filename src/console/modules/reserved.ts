import { consoleResource } from "@/config/console";
import { CatalogError } from "@/modules/resources";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { CONSOLE_CLIENT_ID } from "../identity";

// What the console itself signs in with (the `2026-11-12-console` migration):
// changing or deleting it through the console would lock every operator out,
// so the console API refuses; the scripts and the migration still can.
const onPlatform = (tenant: { slug: string }) =>
  tenant.slug === PLATFORM_TENANT_SLUG;

/** Refuses a write on the console's own client. */
export function keepConsoleClient(tenant: { slug: string }, clientId: string) {
  if (onPlatform(tenant) && clientId === CONSOLE_CLIENT_ID) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      "The console's own client cannot be changed here",
    );
  }
}

/** Refuses a deletion on the console's own resource (or one of its scopes). */
export function keepConsoleResource(
  tenant: { slug: string },
  resource: { uri: string } | undefined,
) {
  if (onPlatform(tenant) && resource?.uri === consoleResource) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      "The console's own resource and its scopes cannot be deleted",
    );
  }
}

/**
 * Refuses the client credentials grant on the console's own resource: the
 * console takes an operator's token only (a client-only token is no operator),
 * so no machine token is ever minted for it. Role-based access is refused too
 * (`enforceRbac`, BAD_USER_INPUT at that field).
 */
export function refuseMachineConsole(
  tenant: { slug: string },
  resource: { uri: string } | undefined,
  allow: boolean | null | undefined,
  enforceRbac?: boolean | null | undefined,
) {
  if (
    enforceRbac === true &&
    onPlatform(tenant) &&
    resource?.uri === consoleResource
  ) {
    // The console's own rules read the token's scopes, never `permissions`.
    throw new CatalogError(
      "BAD_USER_INPUT",
      "The console's own resource is guarded by its own rules: it cannot enforce role-based access",
      "enforceRbac",
    );
  }
  if (
    allow === true &&
    onPlatform(tenant) &&
    resource?.uri === consoleResource
  ) {
    throw new CatalogError(
      "BAD_USER_INPUT",
      "The console's own resource takes an operator's token only: it cannot allow the client credentials grant",
    );
  }
}
