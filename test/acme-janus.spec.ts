import { describe, expect, test } from "bun:test";
import { acmeJanus, acmeTenant } from "~/acme-janus";

describe("acmeTenant", () => {
  test("is the active acme tenant with its related origin", () => {
    expect(acmeTenant).toMatchObject({
      slug: "acme",
      status: "active",
      plan: "free",
      relatedOrigins: ["https://auth.acme.com"],
    });
    expect(acmeTenant.oauth.agents.dynamic).toBe("off");
  });
});

describe("acmeJanus", () => {
  test("builds a janus instance with the members a spec reads", () => {
    const janus = acmeJanus();
    expect(janus.authenticate).toBeFunction();
  });

  test("gives a copy of its own each call", () => {
    expect(acmeJanus()).not.toBe(acmeJanus());
  });
});
