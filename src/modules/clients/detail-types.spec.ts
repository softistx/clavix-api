import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEVICE_GRANT,
  s256Challenge,
  TOKEN_EXCHANGE_GRANT,
} from "@softistx/janus-oauth";
import { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import { scopeToTenant } from "@softistx/mongo";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { resourcesService } from "@/config/resources";
import { consentReadyOf, mongoClientDetailTypes } from "@/modules/resources";
import { PLATFORM_TENANT_SLUG, partitionOf } from "@/modules/tenants";
import { CliInputError } from "@/shared/cli";
import { createFlow, REDIRECT } from "~/oauth-flow";
import { parseClientArgs } from "./cli";
import { registerClient } from "./register-client";

const PAY = "https://pay.example/api";
const flow = createFlow();
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const ready = mongoClientDetailTypes(mongo.db.detailTypes, () => true);
const notReady = mongoClientDetailTypes(mongo.db.detailTypes, () => false);
const text = (en: string) => ({ fr: en, en });
const VERIFIER = "r".repeat(64);

const register = (
  slug: string,
  input: Partial<Parameters<typeof registerClient>[1]> = {},
  port: typeof ready | null = ready,
) =>
  registerClient(
    {
      now: () => new Date(),
      db: oauthDb,
      findTenant,
      ...(port === null ? {} : { detailTypes: port }),
    },
    {
      tenant: slug,
      name: "Payer",
      clientId: "payer",
      redirectUris: [REDIRECT],
      type: "confidential",
      requirePar: true,
      ...input,
    },
  );

const storedOf = async (slug: string) => {
  const tenant = await findTenant(slug);
  if (tenant === undefined) throw new Error(`no tenant ${slug}`);
  return createMongoOAuth(oauthDb, { partition: partitionOf(tenant._id) });
};

async function addType(slug: string, type: string) {
  const tenant = await findTenant(slug);
  if (tenant === undefined) throw new Error("no tenant");
  const resource = await scopeToTenant(
    mongo.db.resources,
    tenant._id,
  ).findFirst({ uri: PAY });
  if (resource === undefined) throw new Error("no resource");
  await resourcesService.createDetailType(
    tenant._id,
    resource._id.toHexString(),
    {
      type,
      name: text(type),
      fields: [{ key: "amount", kind: "number", label: text("Amount") }],
    },
  );
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (error: unknown) => (error instanceof CliInputError ? error.message : "?"),
  );

beforeAll(async () => {
  for (const slug of ["r3-a", "r3-b"]) {
    await flow.setUp(slug, [PAY], { par: true });
    await addType(slug, "payment");
  }
  await addType("r3-a", "transfer");
});

afterAll(async () => {
  await mongo.db.tenants.raw.deleteMany({
    slug: { $ne: PLATFORM_TENANT_SLUG },
  });
});

describe("a client's detail types", () => {
  test("a listed type is stored on the client and returned", async () => {
    const done = await register("r3-a", {
      detailTypes: ["payment", "payment"],
    });
    expect(done.detailTypes).toEqual(["payment"]);
    expect(
      (await (await storedOf("r3-a")).findClient("payer"))
        ?.authorizationDetailsTypes,
    ).toEqual(["payment"]);
  });

  test("an unknown type, or another tenant's, is refused", async () => {
    expect(
      await refusal(register("r3-a", { detailTypes: ["nope"] })),
    ).toContain('unknown detail type "nope"');
    // "transfer" belongs to r3-a only.
    expect(
      await refusal(
        register("r3-b", { clientId: "other", detailTypes: ["transfer"] }),
      ),
    ).toContain('"transfer"');
    expect(await (await storedOf("r3-b")).findClient("other")).toBeNull();
  });

  test("a client that does not require PAR cannot list a type (D3)", async () => {
    const message = await refusal(
      register("r3-a", {
        clientId: "nopar",
        requirePar: false,
        detailTypes: ["payment"],
      }),
    );
    expect(message).toContain("must require PAR");
    expect(await (await storedOf("r3-a")).findClient("nopar")).toBeNull();
  });

  test("turning PAR off on a client that lists types is refused, and nothing changes", async () => {
    await register("r3-a", { clientId: "keeps", detailTypes: ["payment"] });
    expect(
      await refusal(register("r3-a", { clientId: "keeps", requirePar: false })),
    ).toContain("must require PAR");
    expect(
      (await (await storedOf("r3-a")).findClient("keeps"))
        ?.requirePushedAuthorizationRequests,
    ).toBe(true);
  });

  test("the list is kept on a re-run without it, replaced by a new one, cleared by an empty one", async () => {
    await register("r3-a", { clientId: "rerun", detailTypes: ["payment"] });
    const kept = await register("r3-a", { clientId: "rerun", name: "Again" });
    expect(kept.detailTypes).toEqual(["payment"]);
    const replaced = await register("r3-a", {
      clientId: "rerun",
      detailTypes: ["transfer"],
    });
    expect(replaced.detailTypes).toEqual(["transfer"]);
    const cleared = await register("r3-a", {
      clientId: "rerun",
      detailTypes: [],
    });
    expect(cleared.detailTypes).toEqual([]);
    expect(
      (await (await storedOf("r3-a")).findClient("rerun"))
        ?.authorizationDetailsTypes,
    ).toBeUndefined();
  });

  test("a code client of a tenant whose consent page is not ready cannot list a type (rarConsentReady)", async () => {
    const message = await refusal(
      register(
        "r3-a",
        { clientId: "unseen", detailTypes: ["payment"] },
        notReady,
      ),
    );
    expect(message).toContain("cannot let a client that uses /authorize");
    // A device client has the hosted device review: refused too.
    expect(
      await refusal(
        register(
          "r3-a",
          {
            clientId: "tv",
            redirectUris: [],
            grants: [DEVICE_GRANT],
            detailTypes: ["payment"],
          },
          notReady,
        ),
      ),
    ).toContain("or the device grant");
    // A token-exchange-only client has no consent page: allowed.
    const exchange = await register(
      "r3-a",
      {
        clientId: "svc",
        redirectUris: [],
        grants: [TOKEN_EXCHANGE_GRANT],
        detailTypes: ["payment"],
      },
      notReady,
    );
    expect(exchange.detailTypes).toEqual(["payment"]);
    // Adding the device grant to it is the refused step.
    expect(
      await refusal(
        register(
          "r3-a",
          { clientId: "svc", grants: [TOKEN_EXCHANGE_GRANT, DEVICE_GRANT] },
          notReady,
        ),
      ),
    ).toContain("or the device grant");
    // A ready tenant accepts a device client.
    const device = await register(
      "r3-a",
      {
        clientId: "tv",
        redirectUris: [],
        grants: [DEVICE_GRANT],
        detailTypes: ["payment"],
      },
      ready,
    );
    expect(device.detailTypes).toEqual(["payment"]);
  });

  test("without the types port a client cannot list any", async () => {
    expect(
      await refusal(
        register("r3-a", { clientId: "bare", detailTypes: ["payment"] }, null),
      ),
    ).toContain("not available");
  });

  test("consentReadyOf reads slugs and *", () => {
    expect(consentReadyOf("")("a")).toBe(false);
    expect(consentReadyOf(" a , b ")("b")).toBe(true);
    expect(consentReadyOf("a,b")("c")).toBe(false);
    expect(consentReadyOf("*")("c")).toBe(true);
  });

  test("--detail-types reads a list, an empty value clears, absent keeps", () => {
    const line = ["--tenant", "t", "--name", "n"];
    expect(
      parseClientArgs([...line, "--detail-types", "a, b"]).detailTypes,
    ).toEqual(["a", "b"]);
    expect(parseClientArgs([...line, "--detail-types="]).detailTypes).toEqual(
      [],
    );
    expect(parseClientArgs(line).detailTypes).toBeUndefined();
  });
});

describe("a listed type end to end", () => {
  const par = async (details: unknown) => {
    return flow.post(
      "r3-a",
      "/par",
      {
        response_type: "code",
        client_id: "payer",
        redirect_uri: REDIRECT,
        code_challenge: await s256Challenge(VERIFIER),
        code_challenge_method: "S256",
        resource: PAY,
        state: "s",
        authorization_details: JSON.stringify(details),
      },
      flow.basic("payer", payerSecret),
    );
  };
  let payerSecret = "";

  beforeAll(async () => {
    const done = await register("r3-a", {
      clientId: "payer",
      detailTypes: ["payment"],
      rotateSecret: true,
    });
    payerSecret = done.clientSecret ?? "";
  });

  test("/par accepts the listed type and refuses the unlisted one", async () => {
    const ok = await par([{ type: "payment", amount: 1 }]);
    expect(ok.status).toBe(201);
    const refused = await par([{ type: "transfer", amount: 1 }]);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_authorization_details",
    );
  });

  test("a listed type that is no longer stored is refused at the issuer", async () => {
    // The check-then-delete race of deleteDetailType: the type goes, the list keeps it.
    await mongo.db.detailTypes.raw.deleteMany({ type: "payment" });
    const refused = await par([{ type: "payment", amount: 1 }]);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_authorization_details",
    );
  });
});
