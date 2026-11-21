// The module's import surface (the second factor, its sign-in answers and the
// step-up). Imported by file: `mfa.resolver` (`modules/index.ts`), `mfa.errors`
// (`i18n/codes.ts`) and `mfa.challenge`, a leaf with no import of the app
// (`auth.service.ts`: the barrel loads `@/modules/auth`, which would close a cycle).

export { challengeAnswer } from "./mfa.challenge";
export { MfaService } from "./mfa.service";
