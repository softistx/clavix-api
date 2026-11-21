import type { Db } from "mongodb";
import { registerClient } from "@/modules/clients/register-client";
import type { ClientDetailTypes } from "@/modules/resources";
import { CatalogError } from "@/modules/resources";
import { CliInputError, type CliTenant } from "@/shared/cli";

/**
 * Registers (or re-registers) a client of one tenant through the script's
 * `registerClient`, so a console client follows the same rules; a rejected
 * input becomes a `BAD_USER_INPUT` catalog error.
 */
export function registerForTenant(
  options: {
    db: Db;
    now: () => Date;
    detailTypes: ClientDetailTypes | undefined;
  },
  tenant: CliTenant,
  input: Omit<Parameters<typeof registerClient>[1], "tenant">,
) {
  return registerClient(
    {
      db: options.db,
      findTenant: async (slug) => (slug === tenant.slug ? tenant : undefined),
      now: options.now,
      ...(options.detailTypes === undefined
        ? {}
        : { detailTypes: options.detailTypes }),
    },
    { ...input, tenant: tenant.slug },
  ).catch((error) => {
    if (error instanceof CliInputError) {
      throw new CatalogError("BAD_USER_INPUT", error.message);
    }
    throw error;
  });
}
