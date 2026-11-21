import { INVITATION_PATH } from "@/mail/tenant-mail";
import { InvitationsService } from "@/modules/invitations/invitations.service";
import type { TenantInvitations } from "@/modules/invitations/invitations.types";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { env } from "./env";
import { tenantMail } from "./mail";
import { tenantsService } from "./tenancy";
import { usageService } from "./usage";
import { forTenant, janusIssuers } from "./users";

export const invitationsService = new InvitationsService(
  { issuers: janusIssuers, tenants: tenantsService, usage: usageService },
  { maxPending: env.CLAVIX_INVITE_PENDING_LIMIT },
);

/**
 * The invitations of a tenant's user pool: issued by the tenant's janus,
 * mailed in the tenant's name, accepted on its hosted `/invitation` page
 * (`acceptInvitation`). `tenant` is read on every call; `null` (missing or
 * suspended) makes every call throw.
 */
export const invitationsOf = (
  tenant: () => Promise<ResolvedTenant | null>,
): TenantInvitations =>
  invitationsService.bind(async () => {
    const resolved = await tenant();
    const auth = resolved === null ? null : await forTenant(resolved);
    if (resolved === null || auth === null) return null;
    return {
      auth,
      mail: tenantMail(resolved),
      link: (code) =>
        `${resolved.issuer}${INVITATION_PATH}?code=${encodeURIComponent(code)}`,
    };
  });
