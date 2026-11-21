import { describe, expect, test } from "bun:test";
import { DEVICE_GRANT } from "@softistx/janus-oauth";
import { ObjectId } from "mongodb";
import {
  clientsKey,
  grantsOf,
  isClientId,
  kindsOf,
  settingsOf,
  shape,
  target,
} from "./clients.utils";

const tenant = { _id: new ObjectId() };
const client = {
  clientId: "web",
  name: "Web",
  type: "confidential" as const,
  redirectUris: ["https://a.test/cb"],
  grantTypes: ["authorization_code", DEVICE_GRANT, "unknown"],
  createdAt: new Date(0),
  requirePushedAuthorizationRequests: false,
  dpopBoundAccessTokens: true,
  registration: "console" as const,
  authorizationDetailsTypes: [],
  allowedScopes: ["openid"],
  defaultScopes: [],
};

describe("shape", () => {
  test("names the enums and drops a grant the schema does not know", () => {
    const shown = shape(client);
    expect(shown.type).toBe("CONFIDENTIAL");
    expect(shown.registration).toBe("CONSOLE");
    expect(shown.grantTypes).toEqual(["AUTHORIZATION_CODE", "DEVICE_CODE"]);
    expect(shown.tokenExchange).toBeNull();
  });

  test("shows the token exchange rules, any subject as a flag", () => {
    const shown = shape(client, {
      targetResources: ["https://r.test"],
      subjectClients: "any",
      subjectAgents: false,
    } as never);
    expect(shown.tokenExchange).toEqual({
      targetResources: ["https://r.test"],
      subjectClients: [],
      anySubjectClient: true,
      subjectAgents: false,
      mode: "DELEGATION",
    });
  });
});

describe("kindsOf and grantsOf", () => {
  test("map the enum lists, keep an absent one absent", () => {
    expect(kindsOf(["DYNAMIC", "METADATA"])).toEqual(["dynamic", "metadata"]);
    expect(kindsOf(null)).toBeUndefined();
    expect(grantsOf(["DEVICE_CODE"])).toEqual([DEVICE_GRANT]);
    expect(grantsOf(undefined)).toBeUndefined();
  });
});

describe("settingsOf", () => {
  test("an omitted setting stays undefined", () => {
    const settings = settingsOf({ requirePushedAuthorizationRequests: null });
    expect(Object.values(settings).every((value) => value === undefined)).toBe(
      true,
    );
  });

  test("a sent setting is passed on", () => {
    const settings = settingsOf({
      grantTypes: ["REFRESH_TOKEN"],
      dpopBoundAccessTokens: true,
      allowedScopes: ["a"],
    });
    expect(settings.grants).toEqual(["refresh_token"]);
    expect(settings.dpopBound).toBe(true);
    expect(settings.allowedScopes).toEqual(["a"]);
  });
});

describe("target, clientsKey and isClientId", () => {
  test("target keeps 200 characters of the id", () => {
    expect(target(tenant, "x".repeat(300)).id).toHaveLength(200);
    expect(target(tenant, "web").tenantId).toBe(tenant._id.toHexString());
  });

  test("the lock key is per tenant", () => {
    expect(clientsKey(tenant)).toBe(
      `console:clients:${tenant._id.toHexString()}`,
    );
  });

  test("an id is lower-case letters, digits and dashes, up to 64", () => {
    expect(isClientId("my-app-1")).toBe(true);
    expect(isClientId("My App")).toBe(false);
    expect(isClientId("a".repeat(65))).toBe(false);
  });
});
