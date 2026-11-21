import { afterAll, beforeAll } from "bun:test";
import {
  DEVICE_GRANT,
  rotateSigningKeys,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { clientPoliciesService } from "@/config/client-policies";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource, resourcesService } from "@/config/resources";
import { tenantResolver, tenantsService } from "@/config/tenancy";
import { janusIssuers } from "@/config/users";
import { registerClient } from "@/modules/clients";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import {
  findTenant,
  OTHER,
  PAY,
  REDIRECT,
  ready,
  SLUG,
  secrets,
  signIn,
  signingKeysFor,
  text,
  url,
} from "~/rar";
import { createTenantParOff } from "~/tenant-par-off";

/** Registers the three clients (payer, tv, svc) and the token-exchange rule of the service client. */
async function registerClients(
  tenant: NonNullable<Awaited<ReturnType<typeof findTenant>>>,
) {
  const register = async (
    clientId: string,
    input: Partial<Parameters<typeof registerClient>[1]>,
  ) => {
    const done = await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant, detailTypes: ready },
      {
        tenant: SLUG,
        name: clientId,
        clientId,
        redirectUris: [],
        type: "confidential",
        requirePar: true,
        ...input,
      },
    );
    secrets[clientId] = done.clientSecret ?? "";
  };
  await register("payer", {
    redirectUris: [REDIRECT],
    detailTypes: ["payment"],
  });
  await register("tv", { grants: [DEVICE_GRANT], detailTypes: ["payment"] });
  await register("svc", { grants: [TOKEN_EXCHANGE_GRANT] });
  await clientPoliciesService.setTokenExchange(tenant._id, "svc", {
    targetResources: [PAY, OTHER],
    subjectClients: ["payer"],
    subjectAgents: false,
    mode: "delegation",
  });
}

/** Registers the `rar` tenant, its resource, detail type, clients and a signed-in user for the spec file that calls it. */
export function useRarTenant() {
  beforeAll(async () => {
    await createTenantParOff(tenantsService, { slug: SLUG, name: SLUG });
    const tenant = await findTenant(SLUG);
    const resolved = await tenantResolver.resolveHost(new URL(url()).host);
    if (tenant === undefined || resolved === null) throw new Error("no tenant");
    await rotateSigningKeys(signingKeysFor(resolved.tenantId), {
      now: new Date(),
      lead: "1h",
      retireAfter: "2h",
    });
    for (const uri of [PAY, OTHER]) {
      await registerStoredResource({ tenant: SLUG, uri, scopes: ["read"] });
    }
    const pay = await mongo.db.resources.findFirst({
      uri: PAY,
      tenantId: tenant._id,
    });
    if (pay === undefined) throw new Error("no resource");
    await resourcesService.createDetailType(tenant._id, pay._id.toHexString(), {
      type: "payment",
      name: text("Paiement", "Payment"),
      description: text("Initier des virements", "Start transfers"),
      actions: [
        { value: "initiate", label: text("Initier", "Initiate") },
        { value: "cancel", label: text("Annuler", "Cancel") },
      ],
      fields: [
        { key: "amount", kind: "number", label: text("Montant", "Amount") },
        {
          key: "currency",
          kind: "enum",
          label: text("Devise", "Currency"),
          values: [{ value: "EUR", label: text("Euro", "Euro") }],
        },
        { key: "urgent", kind: "boolean", label: text("Urgent", "Urgent") },
        { key: "memo", kind: "string", label: text("Motif", "Memo") },
      ],
    });
    await registerClients(tenant);
    const auth = await janusIssuers.forRequest(new Request(url()));
    if (auth === null) throw new Error("no janus");
    const user = await auth.create({ email: "ada@example.test" });
    const session = await auth.signInProven(user);
    if (session.status !== "signedIn") throw new Error("no session");
    signIn(session.token);
  });

  afterAll(async () => {
    await mongo.db.tenants.raw.deleteMany({
      slug: { $ne: PLATFORM_TENANT_SLUG },
    });
    await oauthDb.collection("partitionedUsers").deleteMany({});
    await oauthDb.collection("partitionedSessions").deleteMany({});
  });
}
