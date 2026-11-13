import { denial } from "@softistx/janus-graphql";
import type { ConsoleDirectory } from "../context";

/** The tenant when it exists and is active, else a 404. Shared by the modules that need its name. */
export async function activeTenant(directory: ConsoleDirectory, id: string) {
  const [tenant] = await directory.tenantsByIds([id]);
  if (tenant === undefined) throw denial("NOT_FOUND", "No such tenant");
  return tenant;
}
