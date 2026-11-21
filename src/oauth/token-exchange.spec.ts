import { beforeAll, describe, expect, test } from "bun:test";
import { TOKEN_EXCHANGE_GRANT } from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import { agentClientsService } from "@/config/agent-clients";
import { clientPoliciesService } from "@/config/client-policies";
import { clientsService } from "@/config/clients";
import { mongo } from "@/config/db";
import { noDetailTypes } from "@/config/no-ops";
import { oauthDb } from "@/config/oauth-db";
import { registerStoredResource } from "@/config/resources";
import { registerClient } from "@/modules/clients";
import { jsonOf } from "~/json";
import { answerBody, recordBody } from "~/oauth-bodies";
import { createFlow } from "~/oauth-flow";

const SOURCE = "https://source.tx.example/api";
const TARGET = "https://target.tx.example/api";
const OTHER = "https://other.tx.example/api";
const flow = createFlow();
const findTenant = (slug: string) => mongo.db.tenants.findFirst({ slug });
const SUBJECT = "user-subject";

const ids: Record<string, string> = {};
const secrets: Record<string, string> = {};

/** A tenant with resources SOURCE (read, write), TARGET (read) and OTHER (read), and the exchanging client `exch`. */
async function tenant(slug: string, rules: boolean | "none" = true) {
  const { tenantId } = await flow.setUp(slug);
  ids[slug] = String(tenantId);
  await registerStoredResource({
    tenant: slug,
    uri: SOURCE,
    scopes: ["read", "write"],
  });
  await registerStoredResource({ tenant: slug, uri: TARGET, scopes: ["read"] });
  await registerStoredResource({ tenant: slug, uri: OTHER, scopes: ["read"] });
  const exch = await registerClient(
    {
      detailTypes: noDetailTypes,
      now: () => new Date(),
      db: oauthDb,
      findTenant,
    },
    {
      tenant: slug,
      name: "Exchanger",
      clientId: "exch",
      redirectUris: [],
      type: "confidential",
      grants: [TOKEN_EXCHANGE_GRANT],
    },
  );
  secrets[slug] = exch.clientSecret ?? "";
  if (rules !== "none") {
    await clientPoliciesService.setTokenExchange(
      new ObjectId(ids[slug]),
      "exch",
      {
        targetResources: [TARGET],
        subjectClients: ["backend"],
        subjectAgents: false,
        mode: "delegation",
      },
    );
  }
}

const subjectToken = async (slug: string, scope = "read write") =>
  (await flow.tokensOf(slug, scope, { resource: SOURCE, userId: SUBJECT }))
    .access_token;

const exchange = (
  slug: string,
  subject: string,
  extra: Record<string, string> = { resource: TARGET },
  client = { id: "exch", secret: secrets[slug] ?? "" },
) =>
  flow.post(
    slug,
    "/token",
    {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subject,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      ...extra,
    },
    flow.basic(client.id, client.secret),
  );

const answerOf = async (response: Response) => jsonOf(response, answerBody);

const introspect = async (slug: string, token: string) =>
  jsonOf(
    await flow.post(
      slug,
      "/introspect",
      { token },
      flow.basic("backend", flow.clients[slug]?.secret ?? ""),
    ),
    recordBody,
  );

beforeAll(async () => {
  for (const slug of ["tx-a", "tx-b", "tx-norules"]) {
    await tenant(slug, slug === "tx-norules" ? "none" : true);
  }
});

describe("the token exchange grant", () => {
  test("a delegated token carries act, in the JWT and in introspection, and has no refresh token", async () => {
    const response = await exchange("tx-a", (await subjectToken("tx-a")) ?? "");
    expect(response.status).toBe(200);
    const body = await answerOf(response);
    expect(body.issued_token_type).toBe(
      "urn:ietf:params:oauth:token-type:access_token",
    );
    expect(body.refresh_token ?? null).toBeNull();
    const claims = decodeJwt(body.access_token ?? "");
    expect(claims["sub"]).toBe(SUBJECT);
    expect(claims["aud"]).toBe(TARGET);
    expect(claims["act"]).toEqual({ sub: "exch", client_id: "exch" });
    expect(await introspect("tx-a", body.access_token ?? "")).toMatchObject({
      active: true,
      sub: SUBJECT,
      act: { sub: "exch", client_id: "exch" },
    });
  });

  test("scopes only narrow", async () => {
    const subject = (await subjectToken("tx-a", "read write")) ?? "";
    // The target offers `read` only: with no `scope`, that is what is kept.
    const narrowed = await answerOf(await exchange("tx-a", subject));
    expect(narrowed.scope).toBe("read");
    // A scope the target does not offer, or the subject lacks, is refused.
    for (const scope of ["write", "admin"]) {
      const refused = await exchange("tx-a", subject, {
        resource: TARGET,
        scope,
      });
      expect(refused.status).toBe(400);
      expect((await answerOf(refused)).error).toBe("invalid_scope");
    }
    const readOnly = (await subjectToken("tx-a", "read")) ?? "";
    const asked = await exchange("tx-a", readOnly, {
      resource: TARGET,
      scope: "read write",
    });
    expect((await answerOf(asked)).error).toBe("invalid_scope");
  });

  test("a subject client that is not listed is refused", async () => {
    const second = await registerClient(
      {
        detailTypes: noDetailTypes,
        now: () => new Date(),
        db: oauthDb,
        findTenant,
      },
      {
        tenant: "tx-a",
        name: "Second",
        clientId: "second",
        redirectUris: ["https://app.example/callback"],
        type: "confidential",
        rotateSecret: true,
      },
    );
    const token = (
      await flow.tokensOf("tx-a", "read", {
        resource: SOURCE,
        userId: SUBJECT,
        client: { id: "second", secret: second.clientSecret ?? "" },
      })
    ).access_token;
    const refused = await exchange("tx-a", token);
    expect(refused.status).toBe(400);
    expect((await answerOf(refused)).error).toBe("access_denied");
    // Listing `any` lets it through.
    await clientPoliciesService.setTokenExchange(
      new ObjectId(ids["tx-a"]),
      "exch",
      {
        targetResources: [TARGET],
        subjectClients: "any",
        subjectAgents: false,
        mode: "delegation",
      },
    );
    expect((await exchange("tx-a", token)).status).toBe(200);
    await clientPoliciesService.setTokenExchange(
      new ObjectId(ids["tx-a"]),
      "exch",
      {
        targetResources: [TARGET],
        subjectClients: ["backend"],
        subjectAgents: false,
        mode: "delegation",
      },
    );
  });

  test("with subjectAgents an MCP server exchanges an agent's token, and only an agent's", async () => {
    const slug = "tx-a";
    const id = new ObjectId(ids[slug]);
    const register = async (clientId: string) =>
      (
        await registerClient(
          {
            detailTypes: noDetailTypes,
            now: () => new Date(),
            db: oauthDb,
            findTenant,
          },
          {
            tenant: slug,
            name: clientId,
            clientId,
            redirectUris: ["https://app.example/callback"],
            type: "confidential",
            rotateSecret: true,
          },
        )
      ).clientSecret ?? "";
    const agentSecret = await register("agent-x");
    const plainSecret = await register("plain-x");
    await agentClientsService.record(String(id), {
      clientId: "agent-x",
      kind: "dynamic",
    });
    const tokenOf = async (clientId: string, secret: string) =>
      (
        await flow.tokensOf(slug, "read", {
          resource: SOURCE,
          userId: SUBJECT,
          client: { id: clientId, secret },
        })
      ).access_token ?? "";
    const agentToken = await tokenOf("agent-x", agentSecret);
    const plainToken = await tokenOf("plain-x", plainSecret);
    const rules = (subjectAgents: boolean) =>
      clientPoliciesService.setTokenExchange(id, "exch", {
        targetResources: [TARGET],
        subjectClients: [],
        subjectAgents,
        mode: "delegation",
      });
    try {
      // Switch off: the agent's token is refused.
      await rules(false);
      expect((await answerOf(await exchange(slug, agentToken))).error).toBe(
        "access_denied",
      );
      // Switch on: delegation, `act` names the MCP server, the user stays the subject.
      await rules(true);
      const done = await exchange(slug, agentToken);
      expect(done.status).toBe(200);
      const claims = decodeJwt((await answerOf(done)).access_token ?? "");
      expect(claims["sub"]).toBe(SUBJECT);
      expect(claims["aud"]).toBe(TARGET);
      expect(claims["act"]).toEqual({ sub: "exch", client_id: "exch" });
      // A client that is no agent is not covered.
      expect((await answerOf(await exchange(slug, plainToken))).error).toBe(
        "access_denied",
      );
      // Another tenant's record of the same id does not make it an agent here.
      expect(await agentClientsService.has(ids["tx-b"] ?? "", "agent-x")).toBe(
        false,
      );
    } finally {
      await clientPoliciesService.setTokenExchange(id, "exch", {
        targetResources: [TARGET],
        subjectClients: ["backend"],
        subjectAgents: false,
        mode: "delegation",
      });
    }
  });

  test("a target that is not listed is refused", async () => {
    const refused = await exchange("tx-a", (await subjectToken("tx-a")) ?? "", {
      resource: OTHER,
      scope: "read",
    });
    expect(refused.status).toBe(400);
    expect((await answerOf(refused)).error).toBe("access_denied");
  });

  test("a client with no rules is refused, whatever it asks", async () => {
    const refused = await exchange(
      "tx-norules",
      (await subjectToken("tx-norules")) ?? "",
    );
    expect((await answerOf(refused)).error).toBe("access_denied");
  });

  test("a client that does not list the grant, and a public client, are refused", async () => {
    const subject = (await subjectToken("tx-a")) ?? "";
    // `backend` is confidential and lists the code grant only.
    const unlisted = await exchange(
      "tx-a",
      subject,
      { resource: TARGET },
      {
        id: "backend",
        secret: flow.clients["tx-a"]?.secret ?? "",
      },
    );
    expect((await answerOf(unlisted)).error).toBe("unauthorized_client");
    // A public client cannot hold the grant at all.
    await expect(
      registerClient(
        {
          detailTypes: noDetailTypes,
          now: () => new Date(),
          db: oauthDb,
          findTenant,
        },
        {
          tenant: "tx-a",
          name: "Public",
          clientId: "pub-ex",
          redirectUris: [],
          type: "public",
          grants: [TOKEN_EXCHANGE_GRANT],
        },
      ),
    ).rejects.toThrow("confidential client");
    await registerClient(
      {
        detailTypes: noDetailTypes,
        now: () => new Date(),
        db: oauthDb,
        findTenant,
      },
      {
        tenant: "tx-a",
        name: "Public",
        clientId: "pub-ex",
        redirectUris: ["https://app.example/callback"],
        type: "public",
      },
    );
    const publicTry = await flow.post("tx-a", "/token", {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subject,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: TARGET,
      client_id: "pub-ex",
    });
    expect(publicTry.status).toBeGreaterThanOrEqual(400);
    expect((await answerOf(publicTry)).error).toBeDefined();
  });

  test("another tenant's token is refused", async () => {
    const foreign = (await subjectToken("tx-b")) ?? "";
    const refused = await exchange("tx-a", foreign);
    expect(refused.status).toBe(400);
    expect((await answerOf(refused)).error).toBe("invalid_grant");
  });

  test("the rules of a client are its tenant's: the same id elsewhere has none", async () => {
    expect(
      await clientPoliciesService.tokenExchange(
        new ObjectId(ids["tx-norules"]),
        "exch",
      ),
    ).toBeNull();
    expect(
      await clientPoliciesService.tokenExchange(
        new ObjectId(ids["tx-a"]),
        "exch",
      ),
    ).not.toBeNull();
  });

  test("revoking the subject's grant kills the exchanged token", async () => {
    const subject = (await subjectToken("tx-b")) ?? "";
    const body = await answerOf(await exchange("tx-b", subject));
    expect((await introspect("tx-b", body.access_token ?? ""))["active"]).toBe(
      true,
    );
    const server = await flow.issuers.serverFor(
      new Request(flow.url("tx-b", "/")),
    );
    if (server === null) throw new Error("no server");
    expect(await server.grants.revokeAll({ id: SUBJECT })).toBeGreaterThan(0);
    expect((await introspect("tx-b", body.access_token ?? ""))["active"]).toBe(
      false,
    );
  });

  test("deleting the client removes its rules", async () => {
    const tenantDoc = await findTenant("tx-a");
    if (tenantDoc === undefined) throw new Error("no tenant");
    const id = new ObjectId(ids["tx-a"]);
    expect(
      await clientPoliciesService.tokenExchange(id, "exch"),
    ).not.toBeNull();
    expect(await clientsService.delete(tenantDoc, "exch")).toEqual({
      removed: true,
      unmanaged: false,
    });
    expect(await clientPoliciesService.tokenExchange(id, "exch")).toBeNull();
  });
});
