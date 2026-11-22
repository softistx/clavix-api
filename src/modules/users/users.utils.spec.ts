import { describe, expect, test } from "bun:test";
import { emptyProfile } from "@/modules/profile";
import { grantShape, shape, target, view } from "./users.utils";

const createdAt = new Date("2026-01-01T00:00:00Z");
const record = {
  id: "u1",
  email: "ada@x.test",
  name: undefined,
  emailVerified: true,
  active: true,
  createdAt,
  profile: emptyProfile(createdAt),
};

describe("view", () => {
  test("keeps the fields the console shows", () => {
    const user = {
      ...record,
      type: "user" as const,
      logins: { email: "ada@x.test" },
      hasPassword: false,
      hasSecondFactor: false,
      avatar: null,
      version: 1,
      updatedAt: createdAt,
    };
    expect(view(user)).toEqual({ ...record });
  });
});

describe("shape", () => {
  test("adds the tenant and turns a missing name into null", () => {
    expect(shape(record, "t1")).toEqual({
      tenantId: "t1",
      ...record,
      name: null,
    });
  });
});

describe("grantShape", () => {
  test("copies the scopes", () => {
    const scopes = ["openid"];
    const shaped = grantShape({
      id: "g",
      clientId: "c",
      clientName: null,
      resource: "https://api.example.test",
      scopes,
      createdAt,
      updatedAt: createdAt,
    });
    expect(shaped.scopes).toEqual(scopes);
    expect(shaped.scopes).not.toBe(scopes);
  });
});

describe("target", () => {
  test("names the audited object and its tenant", () => {
    expect(target("user", "u1", "t1")).toEqual({
      type: "user",
      id: "u1",
      tenantId: "t1",
    });
  });
});
