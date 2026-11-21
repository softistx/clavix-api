import type { ClientDetailTypes } from "@/modules/resources";
import { CliInputError, type CliTenant } from "@/shared/cli";
import { unique } from "@/shared/values";

/**
 * The detail types a client will list (R3). `asked` replaces the list (`[]`
 * clears it); left out, the stored list is kept. Judged on the final client:
 * a listed type needs the client to push its requests (D3, details in a URL
 * are not protected). Each asked type must be stored by the tenant. A kept type that is no longer stored (a race with a delete)
 * stays on the record: the issuer serves only the stored types, so a request
 * for it is `invalid_authorization_details`.
 */
export async function detailTypesOf(
  port: ClientDetailTypes,
  tenant: CliTenant,
  asked: readonly string[] | undefined,
  kept: readonly string[],
  client: { requirePar: boolean },
): Promise<string[]> {
  const listed = unique(asked ?? kept);
  if (listed.length === 0) return [];
  if (asked !== undefined) {
    const known = await port.namesOf(tenant);
    const unknown = listed.filter((type) => !known.has(type));
    if (unknown.length > 0) {
      throw new CliInputError(
        `unknown detail type${unknown.length > 1 ? "s" : ""} ${unknown.map((type) => `"${type}"`).join(", ")}: a client lists only the types of its tenant (create them on a resource first)`,
      );
    }
  }
  if (!client.requirePar) {
    throw new CliInputError(
      "a client that lists detail types must require PAR (--require-par): authorization details in a URL are not protected",
    );
  }
  return listed;
}
