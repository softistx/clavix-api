import { describe, expect, test } from "bun:test";
import { MCP_CLIENT_REDIRECT_URIS } from "@softistx/janus-oauth";
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

  test("documents are served on the HTTPS port only, unless the ports are widened", () => {
    const policy = { ...agentsOff(), metadataDocuments: true };
    const ports = (registration: Registration) =>
      defined(documentsOf(registration).allowPorts, "allowPorts");
    expect(ports(registrationOf(policy))).toEqual([443]);
    expect(ports(registrationOf(policy, {}, [443, 8443]))).toEqual([443, 8443]);
  });
});
