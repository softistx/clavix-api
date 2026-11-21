import { describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { noDetailTypes } from "@/config/no-ops";
import type { ClientPoliciesService } from "@/modules/client-policies";
import type { CliTenant } from "@/shared/cli";
import { ClientsService } from "./clients.service";
import type { AgentsReader } from "./clients.types";

// The checks that run before any store read: the full service paths are
// covered by `clients.console.spec.ts` and `clients.agents.console.spec.ts`.
const tenant = { _id: new ObjectId(), slug: "acme" } as CliTenant;
const agents: AgentsReader = {
  kinds: async (_tenantId, ids) =>
    new Map(
      (ids ?? []).filter((id) => id === "agent").map((id) => [id, "dynamic"]),
    ),
  remove: async () => undefined,
} as AgentsReader;

const service = () =>
  new ClientsService({
    db: {} as Db,
    policies: {} as ClientPoliciesService,
    agents,
    detailTypes: noDetailTypes,
    now: () => new Date(0),
  });

describe("ClientsService", () => {
  test("list and count refuse a long search, list a long cursor", async () => {
    await expect(
      service().list(tenant, { limit: 5, q: "x".repeat(101) }),
    ).rejects.toThrow("search");
    await expect(
      service().count(tenant, { q: "x".repeat(101) }),
    ).rejects.toThrow("search");
    await expect(
      service().list(tenant, { limit: 5, after: "x".repeat(201) }),
    ).rejects.toThrow("Unknown cursor");
  });

  test("create refuses an oversized input before any write", async () => {
    await expect(
      service().create(tenant, {
        name: "x".repeat(101),
        type: "public",
        redirectUris: [],
      }),
    ).rejects.toThrow("name");
  });

  test("an agent answers as an unknown client on every write", async () => {
    const clients = service();
    await expect(
      clients.update(tenant, "agent", { name: "New" }),
    ).rejects.toThrow("No such client");
    await expect(clients.rotateSecret(tenant, "agent")).rejects.toThrow(
      "No such client",
    );
    await expect(
      clients.setTokenExchange(
        tenant,
        "agent",
        { targetResources: [], subjectClients: "any" },
        [],
      ),
    ).rejects.toThrow("No such client");
  });
});
