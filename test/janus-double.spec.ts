import { describe, expect, test } from "bun:test";
import { janusOver, passkeyOf, signedAs } from "~/janus-double";

describe("signedAs", () => {
  test("is a session of a verified user with a derived e-mail", () => {
    const signed = signedAs("u1");
    expect(signed.via).toBe("session");
    expect(signed.user).toMatchObject({
      id: "u1",
      email: "u1@x.test",
      emailVerified: true,
      hasSecondFactor: false,
    });
    expect(signed.session).toMatchObject({ id: "s-u1", userId: "u1" });
  });

  test("takes the e-mail the spec gives", () => {
    expect(signedAs("u1", "me@acme.test").user.email).toBe("me@acme.test");
  });
});

describe("passkeyOf", () => {
  test("is a laptop's, the named fields laid over it", () => {
    expect(passkeyOf()).toMatchObject({ credentialId: "cred", name: "Laptop" });
    expect(passkeyOf({ name: "Phone", userId: "u2" })).toMatchObject({
      credentialId: "cred",
      name: "Phone",
      userId: "u2",
    });
  });
});

describe("janusOver", () => {
  test("replaces the faked member only", async () => {
    const signed = signedAs("u1");
    const janus = janusOver({ authenticate: async () => signed });
    expect(await janus.authenticate(new Request("https://x.test"))).toBe(
      signed,
    );
    expect(janus.authenticate).not.toBe(janusOver().authenticate);
  });

  test("gives a fresh copy each time", () => {
    expect(janusOver()).not.toBe(janusOver());
  });
});
