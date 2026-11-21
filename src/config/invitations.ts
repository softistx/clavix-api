import { INVITATION_PATH } from "@/mail/tenant-mail";
import {
  createTenantInvitations,
  type TenantInvitations,
} from "@/modules/invitations/tenant-invitations";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { env } from "./env";
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
  createTenantInvitations(
    async () => {
      const resolved = await tenant();
      const auth = resolved === null ? null : await forTenant(resolved);
      if (resolved === null || auth === null) return null;
      return {
        auth,
        mail: tenantMail(resolved),
        link: (code) =>
          `${resolved.issuer}${INVITATION_PATH}?code=${encodeURIComponent(code)}`,
      };
    },
    { maxPending: env.CLAVIX_INVITE_PENDING_LIMIT },
  );
