// The module's import surface (the second factor, its sign-in answers and the
// step-up). The resolver is not here: `modules/index.ts` imports it by file,
// so this barrel never loads the config wiring back. `mfa.errors` is imported
// by file by i18n/codes.ts, and auth.service.ts imports `mfa.challenge` by
// file: the barrel loads `@/modules/auth`, which would close a cycle
// (AGENTS.md "Layout (A10)").

export { challengeAnswer, challengeOf } from "./mfa.challenge";
export { MfaService } from "./mfa.service";
export type { MfaPorts } from "./mfa.types";
