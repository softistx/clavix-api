import { oauthDb } from "@/config/oauth-db";
import { signInPolicySchema } from "@/modules/sign-in-methods";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { quietJanus } from "~/ports";
import { tenantStandIn } from "~/spec-context";

/** A resolved tenant (`acme`) for the specs that build a tenant's janus instance. */
export const acmeTenant: ResolvedTenant = tenantStandIn({
  tenantId: "65f0000000000000000000aa",
  status: "active",
  issuer: "https://acme.clavix.test",
  slugIssuer: "https://acme.clavix.test",
  relatedOrigins: ["https://auth.acme.com"],
  plan: "free",
  partition: "65f0000000000000000000aa",
  oauth: {
    par: { required: false },
    dpop: { required: false },
    agents: {
      dynamic: "off",
      redirectUris: [],
      metadataDocuments: false,
      allowHosts: [],
    },
  },
  signIn: signInPolicySchema.parse(undefined),
});

/** A real janus instance of `acmeTenant` with quiet ports: a spec lays its fakes over a copy of it (janus freezes its own instance). */
export const acmeJanus = () => quietJanus(oauthDb, acmeTenant);
