import { describe, expect, test } from "bun:test";
import {
  createClientMetadataFetcher,
  MCP_CLIENT_REDIRECT_URIS,
} from "@softistx/janus-oauth";
import { agentsOff } from "@/modules/oauth-policy";
import { defined } from "~/narrow";
import { registrationOf } from "./registration";

type Registration = ReturnType<typeof registrationOf>;

const restrictedOf = ({ dynamic }: Registration) => {
  if (typeof dynamic !== "object") throw new Error("expected restricted");
  return dynamic;
};
const documentsOf = ({ metadataDocuments }: Registration) => {
  if (typeof metadataDocuments !== "object")
    throw new Error("expected documents");
  return metadataDocuments;
};

describe("registrationOf", () => {
  test("off serves nobody", () => {
    expect(registrationOf(agentsOff())).toMatchObject({ dynamic: "off" });
  });

  test("open is open", () => {
    expect(registrationOf({ ...agentsOff(), dynamic: "open" })).toMatchObject({
      dynamic: "open",
    });
  });

  test("restricted is the MCP list plus the tenant's valid URIs, without repeats", () => {
    const registration = registrationOf({
      ...agentsOff(),
      dynamic: "restricted",
      redirectUris: [
        "https://app.example/callback",
        "https://app.example/callback",
        "not a uri",
      ],
    });
    const list = restrictedOf(registration).redirectUris;
    expect(list).toContain("https://app.example/callback");
    expect(list).not.toContain("not a uri");
    expect(list.length).toBe(new Set(list).size);
    for (const uri of MCP_CLIENT_REDIRECT_URIS) expect(list).toContain(uri);
  });

  test("documents are fetched from the MCP hosts and allowHosts only", () => {
    const registration = registrationOf({
      ...agentsOff(),
      metadataDocuments: true,
      allowHosts: ["app.example"],
    });
    const hosts = defined(documentsOf(registration).allowHosts, "allowHosts");
    expect(hosts).toContain("app.example");
    expect(hosts.length).toBeGreaterThan(1);
  });

  test("a stored wildcard over a public suffix is not an allowed host", () => {
    const registration = registrationOf({
      ...agentsOff(),
      metadataDocuments: true,
      allowHosts: ["*.co.uk", "*.github.io", "*.example.com"],
    });
    const hosts = defined(documentsOf(registration).allowHosts, "allowHosts");
    expect(hosts).toContain("*.example.com");
    expect(hosts).not.toContain("*.co.uk");
    expect(hosts).not.toContain("*.github.io");
  });

  test("documents are served on the HTTPS port only, unless the ports are widened", () => {
    const policy = { ...agentsOff(), metadataDocuments: true };
    const ports = (registration: Registration) =>
      defined(documentsOf(registration).allowPorts, "allowPorts");
    expect(ports(registrationOf(policy))).toEqual([443]);
    expect(ports(registrationOf(policy, {}, [443, 8443]))).toEqual([443, 8443]);
  });
});

// janus-oauth's fetcher resolves the host once, refuses a non-public address
// and hands the checked addresses to the transport. These specs pin that
// contract through the options `registrationOf` builds (no network).
describe("registrationOf: the metadata-document fetch", () => {
  const CLIENT_ID = "https://agent.example.com/client.json";
  const policy = {
    ...agentsOff(),
    metadataDocuments: true,
    allowHosts: ["agent.example.com"],
  };
  const documentOf = (clientId: string) => ({
    client_id: clientId,
    redirect_uris: ["https://agent.example.com/cb"],
    client_name: "Agent",
  });

  const run = async (resolved: string[]) => {
    const seen: { url: string; addresses: readonly string[] }[] = [];
    const fetcher = createClientMetadataFetcher(
      documentsOf(
        registrationOf(policy, {
          resolve: async () => resolved,
          fetch: async (url, _init, checked) => {
            seen.push({ url, addresses: checked.addresses });
            return Response.json(documentOf(CLIENT_ID));
          },
        }),
      ),
    );
    const outcome = await fetcher(CLIENT_ID, new Date()).then(
      () => "fetched",
      (error: unknown) => (error instanceof Error ? error.name : "error"),
    );
    return { seen, outcome };
  };

  test("a name that resolves to a private, loopback or link-local address is refused before any connection", async () => {
    for (const address of [
      "10.0.0.5",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.9",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      const { seen, outcome } = await run([address]);
      expect(seen).toEqual([]);
      expect(outcome).not.toBe("fetched");
    }
  });

  test("one private address among public ones refuses the whole name", async () => {
    const { seen, outcome } = await run(["93.184.216.34", "10.0.0.5"]);
    expect(seen).toEqual([]);
    expect(outcome).not.toBe("fetched");
  });

  test("the transport is handed the checked addresses to connect to", async () => {
    const { seen, outcome } = await run(["93.184.216.34"]);
    expect(outcome).toBe("fetched");
    expect(seen).toEqual([{ url: CLIENT_ID, addresses: ["93.184.216.34"] }]);
  });

  test("the default options never switch the address check off", () => {
    const options = documentsOf(registrationOf(policy));
    expect(options.resolve).toBeUndefined();
    expect(options.fetch).toBeUndefined();
  });
});
