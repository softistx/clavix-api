import {
  discoverIssuer,
  type IssuerChecker,
} from "@/modules/connections/connections.discovery";
import { ConnectionsService } from "@/modules/connections/connections.service";
import { systemTxtResolver } from "@/modules/domains/dns";
import { hostOf } from "@/modules/tenants/identity";
import { socialOf } from "@/users/tenant-janus";
import { mongo } from "./db";
import { env } from "./env";
import { connectionSecretBox } from "./keys";
import { tenantAdmin, tenantResolver } from "./tenancy";

interface LinkCountingSocial {
  countLinks(query: { readonly provider: string }): Promise<number>;
}

// The accounts linked through a connection, counted by the tenant's own janus
// instance (\`auth.social.countLinks\`): its stores count within the tenant's
// partition, and the provider name is the connection's id. A tenant with no
// social instance has no link. \`./users\` imports this module, so \`forTenant\`
// is read at call time only.
const linkCount = async (tenantId: string, connectionId: string) => {
  const tenant = await tenantAdmin.find(tenantId);
  const resolved =
    tenant === undefined
      ? null
      : await tenantResolver.resolveHost(
          hostOf(tenant.slug, env.CLAVIX_DOMAIN),
        );
  const { forTenant } = await import("./users");
  const auth = resolved === null ? null : await forTenant(resolved);
  if (auth === null || socialOf(auth) === null) return 0;
  // janus-graphql's \`SocialAuth\` type leaves \`countLinks\` out; the instance has it.
  const { social } = auth as unknown as { social: LinkCountingSocial };
  return social.countLinks({ provider: connectionId });
};

/** The enterprise OIDC connections of the tenants. The collection is tenant-owned: only this wiring and its module reach it. */
export const connectionsService = new ConnectionsService(
  mongo.db.connections,
  connectionSecretBox,
  { txt: systemTxtResolver(), links: linkCount },
);

/** Reads an issuer's discovery document for the console's check (the network). */
export const issuerChecker: IssuerChecker = discoverIssuer;
