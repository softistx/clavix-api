// The module's import surface (invitations: the hosted preview and accept, and
// a tenant's user-pool invitations). The resolver is not here: `modules/index.ts`
// imports it by file, so this barrel never loads the config wiring back. The
// scope helpers and `TenantInvitations` are imported by file
// (`invitations.rules`, `invitations.types`) by the console modules, and
// `invitations.errors` by i18n/codes.ts (AGENTS.md "Layout (A11)").

export {
  type ResendRefusal,
  ResendRefusedError,
  TenantUnavailableError,
} from "./invitations.errors";
export { InvitationsService } from "./invitations.service";
export type {
  InvitationSource,
  InvitationsAuth,
  InvitationsOptions,
  InvitationsPorts,
  InviteInput,
  PendingInvitation,
  ResendInput,
  TenantInvitations,
} from "./invitations.types";
