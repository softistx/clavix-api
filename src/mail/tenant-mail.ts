import { type JanusMail, janusMail } from "@softistx/janus-mail";
import type { Mailer } from "@softistx/mail";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { senderAddress } from "./mailer";

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
      // when the flows that need them (M2) are wired.
      links: {
        verifyEmail: (token) =>
          `${tenant.issuer}/verify?token=${encodeURIComponent(token)}`,
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
