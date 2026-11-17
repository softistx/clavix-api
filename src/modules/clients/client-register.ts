import type { Db } from "mongodb";
import { CliInputError, type CliTenant } from "@/cli/errors";
import { registerClient } from "@/clients/register-client";
import { CatalogError } from "@/modules/resources/catalog.errors";

/**
 * Registers (or re-registers) a client of one tenant through the script's
 * `registerClient`, so a console client follows the same rules; a rejected
 * input becomes a `BAD_USER_INPUT` catalog error.
 */
export function registerForTenant(
  db: Db,
  now: (() => Date) | undefined,
  tenant: CliTenant,
  input: Omit<Parameters<typeof registerClient>[1], "tenant">,
) {
  return registerClient(
    {
      db,
      findTenant: async (slug) => (slug === tenant.slug ? tenant : undefined),
      ...(now === undefined ? {} : { now }),
    },
    { ...input, tenant: tenant.slug },
  ).catch((error) => {
    if (error instanceof CliInputError) {
      throw new CatalogError("BAD_USER_INPUT", error.message);
    }
    throw error;
  });
}
