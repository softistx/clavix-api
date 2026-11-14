import { type JanusMail, janusMail } from "@softistx/janus-mail";
import type { Mailer } from "@softistx/mail";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { senderAddress } from "./mailer";

/** The hosted page a sign-in link opens (clavix-ui); the token is its `token` query parameter. */
export const MAGIC_LINK_PATH = "/sign-in/link";

/** The hosted page a verification e-mail opens (clavix-ui); the token is its `token` query parameter. */
export const VERIFY_EMAIL_PATH = "/verify";

/** The hosted page an invitation e-mail opens (clavix-ui); the code is its `code` query parameter. */
export const INVITATION_PATH = "/invitation";

export interface TenantMailOptions {
  mailer: Mailer;
  /** The apex (`CLAVIX_DOMAIN`): the sender is `no-reply@<domain>`. */
  domain: string;
}

/**
 * The e-mails of a tenant: one platform sender and mailer, the tenant's name
 * as the brand and as the sender's display name, links on the tenant's own
 * host. Built once per tenant version.
 */
export function createTenantMail({ mailer, domain }: TenantMailOptions) {
  const built = new Map<string, { version: number; mail: JanusMail }>();
  return (tenant: ResolvedTenant): JanusMail => {
    const hit = built.get(tenant.tenantId);
    if (hit?.version === tenant.version) return hit.mail;
    const home = `${tenant.issuer}/`;
    const mail = janusMail({
      mailer,
      from: { name: tenant.name, address: senderAddress(domain) },
      brand: tenant.name,
      // The sign-in code e-mail carries no link; the hosted pages answer these
      // when the flows that need them (M2) are wired. `magicLink` is the
      // hosted page that shows a button, which POSTs the token back
      // (`confirmMagicLink`): never a link that signs in on GET.
      links: {
        magicLink: (token) =>
          `${tenant.issuer}${MAGIC_LINK_PATH}?token=${encodeURIComponent(token)}`,
        verifyEmail: (token) =>
          `${tenant.issuer}${VERIFY_EMAIL_PATH}?token=${encodeURIComponent(token)}`,
        resetPassword: (token) =>
          `${tenant.issuer}/reset?token=${encodeURIComponent(token)}`,
        secureAccount: () => `${tenant.issuer}/account`,
        getStarted: () => home,
      },
    });
    built.set(tenant.tenantId, { version: tenant.version, mail });
    return mail;
  };
}
