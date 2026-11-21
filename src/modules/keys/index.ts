// The module's import surface (keys: the tenants' signing keys, their
// rotation, and the reseal of everything sealed under the master keyring).
// `config/keys.ts` builds the process-wide instances. `keys.queue` and
// `keys.worker` are imported by file (`config/redis.ts`, `server.ts`).

export { parseRotateArgs, RESEAL_USAGE, ROTATE_USAGE } from "./keys.cli";
export { createKeyGenerations, type KeyGenerations } from "./keys.generations";
export { resealAllTenants } from "./keys.reseal";
export { resealSecondFactorOf } from "./keys.second-factor-reseal";
export { KeysService } from "./keys.service";
export { createTenantKeys, type TenantKeys } from "./keys.signing-keys";
export { resealExitCode } from "./keys.utils";
