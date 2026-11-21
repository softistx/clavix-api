// The module's import surface (keys: the tenants' signing keys, their
// rotation, and the reseal of everything sealed under the master keyring).
// `config/keys.ts` builds the process-wide instances.

export {
  parseRotateArgs,
  RESEAL_USAGE,
  ROTATE_USAGE,
  type RotateTarget,
} from "./keys.cli";
export { createKeyGenerations, type KeyGenerations } from "./keys.generations";
export { keyRotation } from "./keys.queue";
export { resealAllTenants } from "./keys.reseal";
export { retireAfterMs, rotationPolicy } from "./keys.rules";
export {
  type EmergencyRotation,
  type EmergencyRotationDeps,
  ensureSigningKey,
  type RotationDeps,
  rotateAllTenants,
  rotateNow,
} from "./keys.service";
export {
  createTenantKeys,
  type TenantKeys,
  type TenantKeysOptions,
} from "./keys.signing-keys";
export type {
  ResealDeps,
  ResealReport,
  ResealSecondFactor,
  ResealSecretStore,
  SecondFactorResealCounts,
  SecretStore,
} from "./keys.types";
export { resealExitCode } from "./keys.utils";
export { type RotationQueue, startKeyRotation } from "./keys.worker";
