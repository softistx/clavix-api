import { ObjectId } from "mongodb";
import { mongo } from "@/config/db";
import { ConnectionError } from "@/modules/connections/connections.errors";
import type { ConnectionInput } from "@/modules/connections/connections.types";
import { ConnectionsService } from "@/modules/connections/services";
import type { TxtAnswer } from "@/modules/domains";
import { createSecretBox } from "@/modules/sign-in-methods";
import { QuotaExceededError } from "@/modules/usage";

/**
 * A `ConnectionsService` over the test database with its ports under the
 * spec's hand: the clock, the TXT answer, the linked-account count and the
 * issuers that advertise `iss`. `reset` (run after each test) puts them back
 * and empties the collection.
 */
export const connectionsHarness = () => {
  const collection = mongo.db.connections;
  const box = createSecretBox(
    crypto.getRandomValues(new Uint8Array(32)),
    "connection-secrets",
  );
  const state = {
    clock: new Date("2026-11-18T12:00:00Z"),
    txt: { kind: "none" } as TxtAnswer,
    linked: 0,
    asked: [] as string[],
    logged: [] as string[],
    advertised: new Map<string, boolean | Error>(),
  };
  const service = new ConnectionsService(collection, box, {
    txt: {
      resolveTxt: async (name) => {
        state.asked.push(name);
        return state.txt;
      },
    },
    links: async () => state.linked,
    advertisesIss: async (issuer) => {
      const answer = state.advertised.get(issuer) ?? false;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => state.clock,
    log: (message) => state.logged.push(message),
  });
  const input = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
    id: "acme",
    name: "Acme SSO",
    issuer: "https://login.acme.test",
    clientId: "client-1",
    clientSecret: "s3cr3t-value",
    ...over,
  });
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ConnectionError) return error.code;
      if (error instanceof QuotaExceededError) return "QUOTA";
      return String(error);
    }
    return "ok";
  };
  /** Claims `acme.test` on `id` and verifies it through the TXT record. */
  const verified = async (
    tenantId: string,
    id = "acme",
    domain = "acme.test",
  ) => {
    const added = await service.addDomain(tenantId, id, domain);
    const [entry] = added.domains;
    if (entry === undefined) throw new Error("the claimed domain is missing");
    state.txt = { kind: "records", values: [entry.txtToken] };
    return service.verifyDomain(tenantId, id, domain);
  };
  const reset = async () => {
    state.clock = new Date("2026-11-18T12:00:00Z");
    state.txt = { kind: "none" };
    state.asked.length = 0;
    state.linked = 0;
    state.logged.length = 0;
    state.advertised.clear();
    await collection.raw.deleteMany({});
  };
  return {
    collection,
    box,
    state,
    service,
    input,
    codeOf,
    verified,
    reset,
    A: new ObjectId().toHexString(),
    B: new ObjectId().toHexString(),
  };
};
