import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import type { TenantJanus } from "@/modules/users";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { janusOver, signedAs } from "~/janus-double";
import { tenantStandIn } from "~/spec-context";
import {
  type AccessContext,
  AvatarAccessService,
} from "./avatar-access.service";

const TENANT_ID = "a".repeat(24);

interface Options {
  tenant?: ResolvedTenant | null;
  own?: TenantJanus | null;
  byId?: TenantJanus | null;
  admin?: () => Promise<void>;
  locked?: boolean;
}

function serviceOver(options: Options = {}) {
  const asked: string[] = [];
  const own =
    options.own === undefined
      ? janusOver({ authenticate: async () => signedAs("u1") })
      : options.own;
  const service = new AvatarAccessService({
    issuers: { forRequest: async () => own },
    janusOf: async () =>
      options.byId === undefined ? janusOver() : options.byId,
    pictureLocked: async () => options.locked === true,
    admin: async (_request, tenantId) => {
      asked.push(tenantId);
      await options.admin?.();
      return async () => {};
    },
  });
  const ctxOf = (url: string, headers: HeadersInit = {}): AccessContext => {
    const request = new Request(url, { method: "PUT", headers });
    return {
      request,
      url: new URL(url),
      tenant: async () =>
        options.tenant === undefined ? tenantStandIn() : options.tenant,
    };
  };
  return { service, ctxOf, asked };
}

const refusalOf = async (run: () => Promise<unknown>) => {
  const error = await run().catch((e: unknown) => e);
  return error instanceof MediaRefusal ? error.code : "none";
};

describe("AvatarAccessService: the signed-in user's own picture", () => {
  test("is the session's user on the tenant host", async () => {
    const { service, ctxOf } = serviceOver();
    const target = await service.targetOf(
      ctxOf("https://acme.example/media/avatar"),
    );
    expect(target).toMatchObject({ tenantId: "t1", userId: "u1" });
    expect(target.record).toBeNull();
  });

  test("is decided once per request", async () => {
    const { service, ctxOf } = serviceOver();
    const ctx = ctxOf("https://acme.example/media/avatar");
    expect(await service.targetOf(ctx)).toBe(await service.targetOf(ctx));
  });

  test("a cross-site request is forbidden", async () => {
    const { service, ctxOf } = serviceOver();
    const ctx = ctxOf("https://acme.example/media/avatar", {
      "sec-fetch-site": "cross-site",
    });
    expect(await refusalOf(() => service.targetOf(ctx))).toBe("forbidden");
  });

  test("a host with no tenant, or no janus, is not_found", async () => {
    expect(
      await refusalOf(() => {
        const { service, ctxOf } = serviceOver({ tenant: null });
        return service.targetOf(ctxOf("https://x.example/media/avatar"));
      }),
    ).toBe("not_found");
    expect(
      await refusalOf(() => {
        const { service, ctxOf } = serviceOver({ own: null });
        return service.targetOf(ctxOf("https://x.example/media/avatar"));
      }),
    ).toBe("not_found");
  });

  test("a visitor is unauthenticated, a suspended tenant forbidden", async () => {
    const visitor = serviceOver({
      own: janusOver({ authenticate: async () => null }),
    });
    expect(
      await refusalOf(() =>
        visitor.service.targetOf(
          visitor.ctxOf("https://a.example/media/avatar"),
        ),
      ),
    ).toBe("unauthenticated");
    const suspended = serviceOver({
      tenant: tenantStandIn({ status: "suspended" }),
    });
    expect(
      await refusalOf(() =>
        suspended.service.targetOf(
          suspended.ctxOf("https://a.example/media/avatar"),
        ),
      ),
    ).toBe("forbidden");
  });
});

describe("AvatarAccessService: the PICTURE lock", () => {
  test("refuses the user's own upload as locked", async () => {
    const { service, ctxOf } = serviceOver({ locked: true });
    expect(
      await refusalOf(() =>
        service.targetOf(ctxOf("https://acme.example/media/avatar")),
      ),
    ).toBe("locked");
  });

  test("does not stop an admin's write", async () => {
    const { service, ctxOf } = serviceOver({ locked: true });
    const url = `https://acme.example/media/avatar?tenantId=${TENANT_ID}&userId=u7`;
    expect(await service.targetOf(ctxOf(url))).toMatchObject({ userId: "u7" });
  });
});

describe("AvatarAccessService: an admin's write", () => {
  const url = `https://acme.example/media/avatar?tenantId=${TENANT_ID}&userId=u7`;

  test("names the user once the console says the caller may edit", async () => {
    const { service, ctxOf, asked } = serviceOver();
    const target = await service.targetOf(ctxOf(url));
    expect(target).toMatchObject({ tenantId: TENANT_ID, userId: "u7" });
    expect(target.record).not.toBeNull();
    expect(asked).toEqual([TENANT_ID]);
  });

  test("the console's refusal is the refusal, and nothing is looked up", async () => {
    const { service, ctxOf } = serviceOver({
      admin: async () => {
        throw new MediaRefusal("forbidden");
      },
    });
    expect(await refusalOf(() => service.targetOf(ctxOf(url)))).toBe(
      "forbidden",
    );
  });

  test("a tenant gone is not_found, a partial or malformed query too", async () => {
    const gone = serviceOver({ byId: null });
    expect(await refusalOf(() => gone.service.targetOf(gone.ctxOf(url)))).toBe(
      "not_found",
    );
    const { service, ctxOf } = serviceOver();
    for (const bad of [
      "https://a.example/media/avatar?userId=u7",
      "https://a.example/media/avatar?tenantId=nope&userId=u7",
    ]) {
      expect(await refusalOf(() => service.targetOf(ctxOf(bad)))).toBe(
        "not_found",
      );
    }
  });
});
