// The module's import surface. There is no resolver: the console module
// (`domains.console-resolver.ts`) is the only caller that writes. The
// recheck worker and queue are wired by file (`src/server.ts`,
// `src/config/redis.ts`), so this barrel never loads Redis.

export type { TxtAnswer, TxtResolver } from "./domains.dns";
export { systemTxtResolver } from "./domains.dns";
export {
  DomainError,
  type DomainErrorCode,
  domainNotFound,
} from "./domains.errors";
export type { DomainSystemEvent } from "./domains.events";
export { domainEventInput } from "./domains.events";
export type { DomainDoc } from "./domains.model";
export { lapsedDomainMail } from "./domains.notice";
export {
  type CheckFailure,
  DomainHostError,
  normalizeDomainHost,
  RECHECK_GRACE_DAYS,
  txtNameOf,
  VERIFY_COOLDOWN_SECONDS,
} from "./domains.rules";
export type {
  DomainsServiceOptions,
  RecheckReport,
} from "./domains.service";
export { DomainsService } from "./domains.service";
export {
  platformHostPolicy,
  TLS_ASK_PATH,
  type TlsAskDeps,
  tlsAsk,
} from "./domains.tls-ask";
export { mintToken } from "./domains.utils";
export {
  relatedOrigins,
  relatedOriginsOf,
  WEBAUTHN_WELL_KNOWN,
} from "./domains.well-known";
