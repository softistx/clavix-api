import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import { JanusError } from "@softistx/janus";
import type { TenantJanus } from "@/modules/users";
import { janusOver, signedAs } from "~/janus-double";
import { contextOf, tenantStandIn } from "~/spec-context";
import { AvatarsService } from "./avatars.service";

const failure = (code: string) => Object.assign(new JanusError(code), { code });

/** A janus whose avatar calls are recorded and whose user has (or has not) a picture. */
function janusWith(options: { avatar: boolean; setError?: Error }) {
  const calls: string[] = [];
  const base = janusOver();
  const signed = signedAs("u1");
  const auth: TenantJanus = janusOver({
    authenticate: async () => signed,
    findUser: async (id) =>
      id === "u1"
        ? {
            ...signed.user,
            avatar: options.avatar
              ? { id: "k0", updatedAt: new Date(0) }
              : null,
          }
        : null,
    avatar: {
      ...base.avatar,
      set: async (_user, avatar) => {
        calls.push(`set ${avatar.id}`);
        if (options.setError !== undefined) throw options.setError;
        return signed.user;
      },
      remove: async () => {
        calls.push("remove");
        return signed.user;
      },
    },
  });
  return { auth, calls };
}

const serviceOver = (auth: TenantJanus | null, locked = false) =>
  new AvatarsService({
    issuers: { forRequest: async () => auth },
    pictureLocked: async () => locked,
  });

const codeOf = (run: () => Promise<unknown>) =>
  run().then(
    () => undefined,
    (error: unknown) =>
      error instanceof MediaRefusal
        ? error.code
        : Reflect.get(Reflect.get(error ?? {}, "extensions") ?? {}, "code"),
  );

describe("AvatarsService.set", () => {
  test("records the key of the stored object in janus", async () => {
    const { auth, calls } = janusWith({ avatar: false });
    await serviceOver(auth).set({ tenantId: "t1", userId: "u1", auth }, "k1");
    expect(calls).toEqual(["set k1"]);
  });

  test("an unknown user is not_found and a concurrent write a 409 conflict", async () => {
    const gone = janusWith({ avatar: false, setError: failure("NOT_FOUND") });
    expect(
      await codeOf(() =>
        serviceOver(gone.auth).set(
          { tenantId: "t1", userId: "u9", auth: gone.auth },
          "k1",
        ),
      ),
    ).toBe("not_found");
    const raced = janusWith({
      avatar: false,
      setError: failure("VERSION_CONFLICT"),
    });
    const refusal = await serviceOver(raced.auth)
      .set({ tenantId: "t1", userId: "u1", auth: raced.auth }, "k1")
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: "conflict",
      details: { status: 409 },
    });
  });

  test("another failure is not hidden", async () => {
    const broken = janusWith({ avatar: false, setError: new Error("boom") });
    expect(
      await serviceOver(broken.auth)
        .set({ tenantId: "t1", userId: "u1", auth: broken.auth }, "k1")
        .catch((error: unknown) => String(error)),
    ).toContain("boom");
  });
});

describe("AvatarsService.remove", () => {
  test("removes a picture and says so", async () => {
    const { auth, calls } = janusWith({ avatar: true });
    const target = { tenantId: "t1", userId: "u1", auth };
    expect(await serviceOver(auth).remove(target)).toBe(true);
    expect(calls).toEqual(["remove"]);
  });

  test("a user with no picture, or none, is false and nothing is written", async () => {
    const { auth, calls } = janusWith({ avatar: false });
    const service = serviceOver(auth);
    expect(await service.remove({ tenantId: "t1", userId: "u1", auth })).toBe(
      false,
    );
    expect(await service.remove({ tenantId: "t1", userId: "u9", auth })).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });
});

describe("AvatarsService.removeOwn", () => {
  test("removes the signed-in user's own picture", async () => {
    const { auth, calls } = janusWith({ avatar: true });
    const ctx = contextOf({ tenant: tenantStandIn() });
    expect(await serviceOver(auth).removeOwn(ctx)).toBe(true);
    expect(calls).toEqual(["remove"]);
  });

  test("a locked PICTURE refuses the removal and writes nothing", async () => {
    const { auth, calls } = janusWith({ avatar: true });
    const ctx = contextOf({ tenant: tenantStandIn() });
    expect(await codeOf(() => serviceOver(auth, true).removeOwn(ctx))).toBe(
      "PROFILE_FIELD_LOCKED",
    );
    expect(calls).toEqual([]);
  });

  test("a host that names no tenant is NOT_FOUND, a suspended tenant refused, a visitor UNAUTHENTICATED", async () => {
    const { auth } = janusWith({ avatar: true });
    expect(
      await codeOf(() =>
        serviceOver(auth).removeOwn(contextOf({ tenant: null })),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(() =>
        serviceOver(auth).removeOwn(
          contextOf({ tenant: tenantStandIn({ status: "suspended" }) }),
        ),
      ),
    ).toBe("TENANT_SUSPENDED");
    const visitor = janusOver({ authenticate: async () => null });
    expect(
      await codeOf(() =>
        serviceOver(visitor).removeOwn(contextOf({ tenant: tenantStandIn() })),
      ),
    ).toBe("UNAUTHENTICATED");
  });
});
