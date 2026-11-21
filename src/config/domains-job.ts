import { senderAddress } from "@/mail/mailer";
import { lapsedDomainMail } from "@/modules/domains/notice";
import type { RecheckDeps } from "@/modules/domains/recheck-worker";
import { access } from "./access";
import { env } from "./env";
import { mailer } from "./mail";
import { domainStore, tenantsService } from "./tenancy";

/**
 * The recheck over the real stores. A domain that lapses mails the tenant's
 * owners (users of the `clavix` tenant, found through `findUser`) once.
 */
export const domainRecheckDeps = (
  findUser: (id: string) => Promise<{ email: string } | null>,
): RecheckDeps => ({
  recheckAll: (onUnverified) => domainStore.recheckAll(onUnverified),
  notify: async (domain) => {
    const tenantId = domain.tenantId.toHexString();
    const tenant = await tenantsService.find(tenantId);
    if (tenant === undefined) return;
    const owners = await Promise.all(
      (await access.owners(tenantId)).map((id) => findUser(id)),
    );
    const to = owners.flatMap((owner) => (owner === null ? [] : [owner.email]));
    if (to.length === 0) return;
    await mailer.send(
      lapsedDomainMail({
        to,
        from: { name: "Clavix", address: senderAddress(env.CLAVIX_DOMAIN) },
        tenantName: tenant.name,
        host: domain.host,
        txtToken: domain.txtToken,
        wasPrimary: domain.primary,
      }),
    );
  },
});
