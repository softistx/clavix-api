import { systemTxtResolver } from "@/modules/domains/dns";
import { DomainStore } from "@/modules/domains/domains.service";
import { domainEventInput } from "@/modules/domains/events";
import { adminEventRecorder } from "./admin-events";
import { mongo } from "./db";
import { env } from "./env";

/**
 * The real domain store over the `domains` collection (a platform collection:
 * only this wiring and its module reach it). The resolver's cache is told
 * through `onHostsChanged`, which `config/tenancy.ts` supplies.
 */
export const createDomainStore = (
  options: Pick<
    ConstructorParameters<typeof DomainStore>[1],
    "onHostsChanged" | "slugHostOf"
  >,
) =>
  new DomainStore(mongo.db.domains, {
    ...options,
    record: (event) => adminEventRecorder.record(domainEventInput(event)),
    dns: systemTxtResolver(),
    platformDomain: env.CLAVIX_DOMAIN,
  });
