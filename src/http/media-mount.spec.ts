import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import {
  seaweedfsBinary,
  startTestS3,
  type TestS3,
} from "@softistx/s3/testing";
import { telemetry } from "@/config/telemetry";
import { type AvatarThrottle, s3MediaStore } from "@/modules/media";
import type { TenantJanus } from "@/modules/users";
import type { TenantResolver } from "@/tenancy/resolver";
import { janusOver, signedAs } from "~/janus-double";
import { PNG } from "~/png";
import { quietThrottles } from "~/ports";
import { tenantStandIn } from "~/spec-context";
import { createBase } from "./context";
import { mountMedia } from "./media-mount";

// The `/media/avatar` routes over a real S3 API (SeaweedFS, no Docker), as the
// production wiring builds them; skipped where the binary cannot be had.
const startable = process.env["CI"]
  ? true
  : await seaweedfsBinary().then(
      () => true,
      () => false,
    );
const suite = startable ? describe : describe.skip;

const BUCKET = "clavix-media-test";
const HOST = "https://acme.example";
const OTHER_TENANT = "b".repeat(24);
const resolver: TenantResolver = {
  resolveHost: async () => null,
  resolveRequest: async () => tenantStandIn(),
  invalidate: async () => {},
};

let s3: TestS3;
let store: ReturnType<typeof s3MediaStore>;
beforeAll(async () => {
  if (!startable) return;
  s3 = await startTestS3();
  await s3.createBucket(BUCKET);
  store = s3MediaStore({
    bucket: BUCKET,
    endpoint: s3.endpoint,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    region: s3.region,
  });
}, 120_000);
afterAll(async () => {
  await s3?.stop();
});

interface Wiring {
  signedIn?: boolean;
  pictureLocked?: boolean;
  throttle?: AvatarThrottle;
  admin?: (tenantId: string) => Promise<void>;
  setFails?: MediaRefusal;
}

/** The app of a spec: the caller `u1` (or nobody), and what janus was told. */
function appOver(wiring: Wiring = {}) {
  const recorded: Array<{ tenantId: string; userId: string; key: string }> = [];
  const audited: Array<{ tenantId: string; userId: string }> = [];
  const auth: TenantJanus = janusOver({
    authenticate: async () =>
      wiring.signedIn === false ? null : signedAs("u1"),
  });
  const app = mountMedia(
    createBase(resolver, quietThrottles, telemetry, 0),
    {
      store,
      avatars: {
        set: async (target, key) => {
          if (wiring.setFails !== undefined) throw wiring.setFails;
          recorded.push({
            tenantId: target.tenantId,
            userId: target.userId,
            key,
          });
        },
      },
      issuers: { forRequest: async () => auth },
      janusOf: async () => auth,
      pictureLocked: async () => wiring.pictureLocked === true,
      throttle: wiring.throttle ?? { check: async () => {} },
    },
    async (_request, tenantId) => {
      await wiring.admin?.(tenantId);
      return async (userId) => {
        audited.push({ tenantId, userId });
      };
    },
  );
  return { app, recorded, audited };
}

const put = (
  app: ReturnType<typeof appOver>["app"],
  body: Uint8Array<ArrayBuffer>,
  type = "image/png",
  query = "",
  headers: HeadersInit = {},
) =>
  app.request(`${HOST}/media/avatar${query}`, {
    method: "PUT",
    body,
    headers: {
      "content-type": type,
      "content-length": String(body.length),
      ...headers,
    },
  });

const objects = async () => (await store.list({ prefix: "" })).items;

suite("/media/avatar over S3", () => {
  test("the owner's upload is stored under the tenant, recorded, and served public, immutable and nosniff", async () => {
    const { app, recorded, audited } = appOver();
    const response = await put(app, PNG);
    expect(response.status).toBe(200);
    const { key, contentType } = await response.json();
    expect(contentType).toBe("image/png");
    expect(recorded).toEqual([{ tenantId: "t1", userId: "u1", key }]);
    expect(audited).toEqual([]);
    expect((await objects()).map((o) => o.key)).toContain(`t1/avatar/${key}`);

    const read = await appOver({ signedIn: false }).app.request(
      `${HOST}/media/avatar/${key}`,
    );
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);
    expect(read.headers.get("cache-control")).toContain("immutable");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a visitor writes nothing", async () => {
    const before = (await objects()).length;
    const response = await put(appOver({ signedIn: false }).app, PNG);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      errors: [{ extensions: { code: "UNAUTHENTICATED" } }],
    });
    expect((await objects()).length).toBe(before);
  });

  test("a locked picture refuses the user's own upload and an admin's still goes through", async () => {
    const before = (await objects()).length;
    const own = await put(appOver({ pictureLocked: true }).app, PNG);
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({
      errors: [
        { extensions: { code: "PROFILE_FIELD_LOCKED", field: "PICTURE" } },
      ],
    });
    expect((await objects()).length).toBe(before);
    const admin = await put(
      appOver({ pictureLocked: true, admin: async () => {} }).app,
      PNG,
      "image/png",
      `?tenantId=${"c".repeat(24)}&userId=u7`,
    );
    expect(admin.status).toBe(200);
  });

  test("a cross-site write is forbidden", async () => {
    const response = await put(appOver().app, PNG, "image/png", "", {
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
  });

  test("a type that is not PNG, JPEG or WebP is a 415 (SVG included)", async () => {
    const { app } = appOver();
    for (const type of ["image/svg+xml", "text/html", "image/gif"]) {
      const response = await put(app, PNG, type);
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        errors: [{ extensions: { code: "MEDIA_UNSUPPORTED_TYPE" } }],
      });
    }
  });

  test("bytes that are not the declared picture are refused", async () => {
    const response = await put(
      appOver().app,
      new TextEncoder().encode("<svg/>"),
    );
    expect([415, 422]).toContain(response.status);
  });

  test("a picture over 1 MiB is a 413", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    const response = await put(appOver().app, big);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      errors: [{ extensions: { code: "MEDIA_TOO_LARGE" } }],
    });
  });

  test("a throttled upload is a 429 with its wait", async () => {
    const before = (await objects()).length;
    const throttle: AvatarThrottle = {
      check: async () => {
        throw new MediaRefusal("throttled", { retryAfter: 42 });
      },
    };
    const response = await put(appOver({ throttle }).app, PNG);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect((await objects()).length).toBe(before);
  });

  test("an admin writes the named user's picture; one the console refuses writes nothing", async () => {
    const tenantId = "c".repeat(24);
    const allowed = appOver({ admin: async () => {} });
    const ok = await put(
      allowed.app,
      PNG,
      "image/png",
      `?tenantId=${tenantId}&userId=u7`,
    );
    expect(ok.status).toBe(200);
    const { key } = await ok.json();
    expect(allowed.recorded).toEqual([{ tenantId, userId: "u7", key }]);
    // The console caller's write is an admin event; the owner's own is not.
    expect(allowed.audited).toEqual([{ tenantId, userId: "u7" }]);
    expect((await objects()).map((o) => o.key)).toContain(
      `${tenantId}/avatar/${key}`,
    );

    const before = (await objects()).length;
    const denied = appOver({
      admin: async () => {
        throw new MediaRefusal("forbidden");
      },
    });
    const refused = await put(
      denied.app,
      PNG,
      "image/png",
      `?tenantId=${tenantId}&userId=u7`,
    );
    expect(refused.status).toBe(403);
    expect((await objects()).length).toBe(before);
  });

  test("another tenant's picture is a 404 on this host", async () => {
    const other = await store.put(
      { key: `${OTHER_TENANT}/avatar/secret` },
      PNG,
      { type: "image/png" },
    );
    expect(other).toBeUndefined();
    const read = await appOver({ signedIn: false }).app.request(
      `${HOST}/media/avatar/secret`,
    );
    expect(read.status).toBe(404);
  });

  test("a failed record answers its refusal", async () => {
    const { app } = appOver({ setFails: new MediaRefusal("not_found") });
    const response = await put(app, PNG);
    expect(response.status).toBe(404);
  });
});
