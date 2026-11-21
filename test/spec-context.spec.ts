import { describe, expect, test } from "bun:test";
import { contextOf, tenantStandIn } from "~/spec-context";

describe("tenantStandIn", () => {
  test("is a live acme tenant, the fields laid over it", () => {
    const tenant = tenantStandIn();
    expect(tenant).toMatchObject({
      tenantId: "t1",
      slug: "acme",
      signUp: false,
    });
    expect(tenantStandIn({ slug: "beta" }).slug).toBe("beta");
  });
});

describe("contextOf", () => {
  test("is complete and quiet by default", async () => {
    const context = contextOf();
    expect(context.ip).toBe("198.51.100.9");
    expect(context.url.href).toBe("https://acme.example/graphql");
    expect(context.signal.aborted).toBeFalse();
    expect((await context.tenant())?.slug).toBe("acme");
    expect(await context.janus.user()).toBeNull();
    expect(await context.janus.session()).toBeNull();
    expect(context.set.headers).toBeInstanceOf(Headers);
  });

  test("lays what the spec names over the quiet members", async () => {
    const request = new Request("https://other.test/x");
    const headers = new Headers({ a: "1" });
    const context = contextOf({
      request,
      ip: "203.0.113.1",
      headers,
      tenant: null,
      janus: { user: async () => null, session: async () => null },
    });
    expect(context.request).toBe(request);
    expect(context.url.host).toBe("other.test");
    expect(context.ip).toBe("203.0.113.1");
    expect(context.set.headers).toBe(headers);
    expect(await context.tenant()).toBeNull();
  });

  test("takes a throttle of the spec over the quiet one", () => {
    const signInThrottle = contextOf().signInThrottle;
    const context = contextOf({
      throttles: { passkeyThrottle: signInThrottle },
    });
    expect(context.passkeyThrottle).toBe(signInThrottle);
  });
});
