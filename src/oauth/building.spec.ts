import { describe, expect, test } from "bun:test";
import { withoutRbacFlag } from "./building";

describe("withoutRbacFlag", () => {
  test("janus receives no enforceRbac key and every other key unchanged", () => {
    const given = withoutRbacFlag({
      "https://a.test/api": {
        scopes: ["read"],
        clientCredentials: true,
        enforceRbac: true,
      },
      "https://b.test/api": { scopes: ["write"] },
    });
    expect(given["https://a.test/api"]).toEqual({
      scopes: ["read"],
      clientCredentials: true,
    });
    expect(given["https://a.test/api"]).not.toHaveProperty("enforceRbac");
    expect(given["https://b.test/api"]).toEqual({ scopes: ["write"] });
  });
});
