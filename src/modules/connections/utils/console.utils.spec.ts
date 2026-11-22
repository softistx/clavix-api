import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { connectionsKey, connectionTarget } from "./console.utils";

const tenant = new ObjectId();

describe("console utils", () => {
  test("an admin event names the connection and its tenant only", () => {
    expect(connectionTarget(tenant, "acme")).toEqual({
      type: "connection",
      id: "acme",
      tenantId: tenant.toHexString(),
    });
  });

  test("the exclusive key is per tenant", () => {
    expect(connectionsKey({ _id: tenant })).toBe(
      `console:connections:${tenant.toHexString()}`,
    );
  });
});
