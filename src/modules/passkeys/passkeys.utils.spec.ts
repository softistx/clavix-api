import { describe, expect, test } from "bun:test";
import type { Passkey } from "@softistx/janus";
import type { TenantJanus } from "@/modules/users";
import {
  ceremonyOut,
  currentOf,
  passkeyOut,
  responseOf,
} from "./passkeys.utils";

const request = new Request("https://acme.example/graphql");

describe("currentOf", () => {
  test("answers the session of the request", async () => {
    const current = { user: { id: "u1" } };
    const auth = {
      authenticate: async () => current,
    } as unknown as TenantJanus;
    expect(await currentOf(auth, request)).toBe(current as never);
  });

  test("refuses an anonymous request as UNAUTHENTICATED", async () => {
    const auth = { authenticate: async () => null } as unknown as TenantJanus;
    const error = await currentOf(auth, request).catch((caught) => caught);
    expect(error.extensions.code).toBe("UNAUTHENTICATED");
  });
});

describe("responseOf", () => {
  test("parses the JSON text the page sent", () => {
    expect(responseOf('{"id":"a"}')).toEqual({ id: "a" });
  });

  test("refuses text that is not JSON as BAD_USER_INPUT", () => {
    expect(() => responseOf("{nope")).toThrow("response must be a JSON string");
  });
});

describe("passkeyOut", () => {
  const base = {
    credentialId: "cred",
    name: "Laptop",
    transports: ["internal"],
    backupEligible: true,
    backedUp: false,
    createdAt: new Date("2026-11-20T00:00:00Z"),
  } as unknown as Passkey;

  test("shapes a passkey and nulls a never-used one", () => {
    expect(passkeyOut(base)).toEqual({
      id: "cred",
      name: "Laptop",
      transports: ["internal"],
      backupEligible: true,
      backedUp: false,
      createdAt: base.createdAt,
      lastUsedAt: null,
    });
  });
});

describe("ceremonyOut", () => {
  test("sends the options as JSON text beside the challenge", () => {
    const expiresAt = new Date("2026-11-20T00:05:00Z");
    expect(
      ceremonyOut({ options: { a: 1 }, challenge: "c", expiresAt }),
    ).toEqual({
      options: '{"a":1}',
      challenge: "c",
      expiresAt,
    });
  });
});
