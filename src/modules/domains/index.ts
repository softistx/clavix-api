// The module's import surface. There is no hosted resolver: the console module
// (`domains.console-resolver`, loaded by `console/modules/index.ts`) is the only
// caller that writes. The recheck worker and queue are imported by file
// (`server.ts`, `config/redis.ts`, `config/domains-job.ts`), so this barrel never
// loads Redis.

export type { TxtAnswer, TxtResolver } from "./domains.dns";
export { systemTxtResolver } from "./domains.dns";
export { codes } from "./domains.errors";
export { domainEventInput } from "./domains.events";
export { lapsedDomainMail } from "./domains.notice";
export {
  RECHECK_GRACE_DAYS,
  VERIFY_COOLDOWN_SECONDS,
} from "./domains.rules";
export { DomainsService } from "./domains.service";
export { platformHostPolicy, TLS_ASK_PATH, tlsAsk } from "./domains.tls-ask";
export { tlsAskGate, tlsAskLimit } from "./domains.tls-limit";
export { mintToken } from "./domains.utils";
export {
  relatedOrigins,
  relatedOriginsOf,
  WEBAUTHN_WELL_KNOWN,
} from "./domains.well-known";
