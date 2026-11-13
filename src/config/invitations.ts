import {
  createTenantInvitations,
  type TenantInvitations,
} from "@/invitations/tenant-invitations";
import { INVITATION_PATH } from "@/mail/tenant-mail";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { tenantMail } from "./mail";
import { forTenant } from "./users";

/**
 * The invitations of a tenant's user pool: issued by the tenant's janus,
 * mailed in the tenant's name, accepted on its hosted `/invitation` page
 * (`acceptInvitation`). `tenant` is read on every call; `null` (missing or
 * suspended) makes every call throw.
 */
export const invitationsOf = (
  tenant: () => Promise<ResolvedTenant | null>,
): TenantInvitations =>
  createTenantInvitations(async () => {
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
