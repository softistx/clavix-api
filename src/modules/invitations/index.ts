// The module's import surface (invitations: the hosted preview and accept, and
// a tenant's user-pool invitations). `invitations.resolver` is imported by file
// by `modules/index.ts`, and `invitations.errors` by `i18n/codes.ts` and
// `admins.errors.ts` (a leaf: it imports nothing of the app).

export {
  ResendRefusedError,
  TenantUnavailableError,
} from "./invitations.errors";
export {
  adminScope,
  adminTenantOf,
  isOperatorScope,
  operatorScope,
  userScope,
} from "./invitations.rules";
export { InvitationsService } from "./invitations.service";
export type { PendingInvitation, TenantInvitations } from "./invitations.types";
