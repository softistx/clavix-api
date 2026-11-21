import {
  DomainsService,
  domainEventInput,
  systemTxtResolver,
} from "@/modules/domains";
import { adminEventRecorder } from "./admin-events";
import { mongo } from "./db";
import { env } from "./env";
import { clock, warn } from "./runtime";

/**
 * The real domain store over the `domains` collection (a platform collection:
 * only this wiring and its module reach it). The resolver's cache is told
 * through `onHostsChanged`, which `config/tenancy.ts` supplies.
 */
export const createDomainsService = (
  options: Pick<
    ConstructorParameters<typeof DomainsService>[1],
    "onHostsChanged" | "slugHostOf"
  >,
) =>
  new DomainsService(mongo.db.domains, {
    ...options,
    now: clock,
    log: warn,
    record: (event) => adminEventRecorder.record(domainEventInput(event)),
    dns: systemTxtResolver(),
    platformDomain: env.CLAVIX_DOMAIN,
  });
