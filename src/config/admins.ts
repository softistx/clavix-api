import { AdminsService } from "@/modules/admins";
import { access } from "./access";
import { consoleDirectory } from "./console-directory";
import { exclusive } from "./exclusive";

/** The console's memberships: who holds which role on a tenant or the platform. */
export const adminsService = new AdminsService({
  access,
  directory: consoleDirectory,
  exclusive,
});
