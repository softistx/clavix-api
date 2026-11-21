import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { endpointDoc, sealedUnder } from "~/webhook-docs";

describe("sealedUnder", () => {
  test("names the master key and has placeholder bytes", () => {
    expect(sealedUnder("k1")).toEqual({ v: 1, kid: "k1", iv: "iv", ct: "ct" });
    expect(sealedUnder("k1", "other").ct).toBe("other");
  });
});

describe("endpointDoc", () => {
  test("is a complete enabled endpoint, its id the hex of its _id", () => {
    const endpoint = endpointDoc();
    expect(endpoint).toMatchObject({
      enabled: true,
      secrets: [],
      consecutiveGiveUps: 0,
      disabledReason: null,
    });
    expect(endpoint.id).toBe(endpoint._id.toHexString());
  });

  test("keeps the _id the spec gives, and lays its fields over", () => {
    const _id = new ObjectId();
    const endpoint = endpointDoc({
      _id,
      enabled: false,
      url: "https://x.test",
    });
    expect(endpoint.id).toBe(_id.toHexString());
    expect(endpoint).toMatchObject({ enabled: false, url: "https://x.test" });
  });
});
