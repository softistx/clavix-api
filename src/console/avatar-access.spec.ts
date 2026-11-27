import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import { createConsoleDeps } from "@/config/console";
import type { AdminEventInput } from "./admin-events/recorder";
import { consoleAvatarAccess } from "./avatar-access";
import type { ConsoleDeps } from "./plugin";

const TENANT = "a".repeat(24);
const REQUEST = new Request("https://clavix.test/media/avatar", {
  method: "PUT",
});
const base = createConsoleDeps({ serverFor: async () => null });

interface Facts {
  token?: "ok" | "none" | "down";
  verified?: boolean;
  can?: boolean;
  platform?: boolean;
  tenant?: { slug: string; status: "active" | "suspended" } | null;
}

function depsOf(
  facts: Facts = {},
  events: AdminEventInput[] = [],
): ConsoleDeps {
  const tenant =
    facts.tenant === undefined
      ? { slug: "acme", status: "active" as const }
      : facts.tenant;
  return {
    ...base,
    reportError: () => {},
    adminEvents: {
      record: async (event) => {
        events.push(event);
      },
    },
    authenticate: async () => {
      if (facts.token === "down") throw new Error("store down");
      if (facts.token === "none") return null;
      return {
        userId: "caller",
        clientId: "c",
        grantId: "g",
        scopes: ["console"],
        clientName: null,
        bound: null,
        jkt: null,
        authorizationDetails: [],
      };
    },
    access: {
      ...base.access,
      can: async () => facts.can ?? true,
      canPlatform: async () => facts.platform ?? false,
    },
    directory: {
      ...base.directory,
      emailVerified: async () => facts.verified ?? true,
      tenantsByIds: async () =>
        tenant === null
          ? []
          : [{ id: TENANT, name: "Acme", plan: "free", ...tenant }],
    },
  };
}

const refusal = async (facts: Facts | undefined) => {
  const error = await consoleAvatarAccess(
    facts === undefined ? undefined : depsOf(facts),
  )(REQUEST, TENANT).catch((e: unknown) => e);
  return error instanceof MediaRefusal ? error.code : "allowed";
};

describe("consoleAvatarAccess", () => {
  test("a caller who may edit the tenant is allowed", async () => {
    expect(await refusal({})).toBe("allowed");
  });

  test("no console has no such route", async () => {
    expect(await refusal(undefined)).toBe("not_found");
  });

  test("no token is unauthenticated, a token store down unavailable", async () => {
    expect(await refusal({ token: "none" })).toBe("unauthenticated");
    expect(await refusal({ token: "down" })).toBe("unavailable");
  });

  test("an unverified e-mail or a missing edit right is forbidden", async () => {
    expect(await refusal({ verified: false })).toBe("forbidden");
    expect(await refusal({ can: false })).toBe("forbidden");
  });

  test("an unknown tenant is not_found", async () => {
    expect(await refusal({ tenant: null })).toBe("not_found");
  });

  test("a suspended tenant is written only with the platform's edit", async () => {
    const tenant = { slug: "acme", status: "suspended" as const };
    expect(await refusal({ tenant })).toBe("forbidden");
    expect(await refusal({ tenant, platform: true })).toBe("allowed");
  });

  test("Clavix's own tenant is the platform's: a tenant role is not enough", async () => {
    const tenant = { slug: "clavix", status: "active" as const };
    expect(await refusal({ tenant, can: true, platform: false })).toBe(
      "forbidden",
    );
    expect(await refusal({ tenant, can: false, platform: true })).toBe(
      "allowed",
    );
  });
});

describe("the recorder consoleAvatarAccess resolves with", () => {
  test("records the caller's user.setPicture event for the user, ids only", async () => {
    const events: AdminEventInput[] = [];
    const record = await consoleAvatarAccess(depsOf({}, events))(
      REQUEST,
      TENANT,
    );
    await record("u9");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "caller",
      action: "user.setPicture",
      tenantId: TENANT,
      target: { type: "user", id: "u9" },
    });
    expect(events[0]?.requestId).not.toBe("");
  });

  test("a refused caller gets no recorder and nothing is recorded", async () => {
    const events: AdminEventInput[] = [];
    await expect(
      consoleAvatarAccess(depsOf({ can: false }, events))(REQUEST, TENANT),
    ).rejects.toBeInstanceOf(MediaRefusal);
    expect(events).toEqual([]);
  });
});
