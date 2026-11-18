import { describe, expect, test } from "bun:test";
import { MCP_CLIENT_REDIRECT_URIS } from "@softistx/janus-oauth";
import { agentsOff } from "@/modules/oauth-policy/oauth-policy.schema";
import { registrationOf } from "./registration";

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
    const list = (registration.dynamic as { redirectUris: string[] })
      .redirectUris;
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
    const docs = registration.metadataDocuments as { allowHosts: string[] };
    expect(docs.allowHosts).toContain("app.example");
    expect(docs.allowHosts.length).toBeGreaterThan(1);
  });
});
