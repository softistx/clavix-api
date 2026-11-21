import { describe, expect, test } from "bun:test";
import { acmeJanus } from "~/acme-janus";
import { socialOf } from "./users.tenant-janus";

describe("buildTenantJanus", () => {
  test("a tenant's instance has the passkey and step-up surfaces, and its social API", () => {
    const auth = acmeJanus();
    expect(typeof auth.stepUp.confirmPasskey).toBe("function");
    expect(typeof auth.secondFactor.passkeyOptions).toBe("function");
    expect(Object.is(socialOf(auth), auth)).toBe(true);
  });
});

describe("socialOf", () => {
  test("the instance when it has a social API, else null", () => {
    const withSocial = {
      ...acmeJanus(),
      social: { countLinks: async () => 0 },
    };
    const without = { ...acmeJanus() };
    Reflect.deleteProperty(without, "social");
    expect(Object.is(socialOf(withSocial), withSocial)).toBe(true);
    expect(socialOf(without)).toBeNull();
  });
});
