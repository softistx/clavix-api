import { connectionsService } from "@/config/connections";
import { resourcesService } from "@/config/resources";
import { tenantsService } from "@/config/tenancy";
import { webhooksService } from "@/config/webhooks-service";

/**
 * The modules' services (D10). A module's entry is added as it adopts the
 * registry; process-lifetime objects stay in `src/config/`, so the
 * connections and tenants services, built there, are the ones wired here.
 * `services()` therefore returns the process-wide instance until a consumer
 * needs a per-request one (D10 follow-up).
 */
export const services = () => ({
  connections: connectionsService,
  resources: resourcesService,
  tenants: tenantsService,
  webhooks: webhooksService,
});
