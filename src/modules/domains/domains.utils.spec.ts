import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { DomainDoc } from "./domains.model";
import { mintToken, shape } from "./domains.utils";

describe("mintToken", () => {
  test("is unguessable and distinct", () => {
    const a = mintToken();
    expect(a).toStartWith("clavix-verify=");
    expect(a.length).toBeGreaterThan(40);
    expect(mintToken()).not.toBe(a);
  });
});

describe("shape", () => {
  test("spells every stored status for GraphQL", () => {
    const statuses = [
      ["pending", "PENDING"],
      ["verified", "VERIFIED"],
      ["unverified", "UNVERIFIED"],
    ] as const;
    for (const [stored, graphql] of statuses) {
      const _id = new ObjectId();
      const doc: DomainDoc = {
        _id,
        id: _id.toHexString(),
        tenantId: new ObjectId(),
        failingSince: null,
        updatedAt: new Date(0),
        host: "example.com",
        status: stored,
        txtToken: "t",
        primary: false,
        verifiedAt: null,
        checkedAt: null,
        createdAt: new Date(0),
      };
      expect(shape(doc).status).toBe(graphql);
    }
  });
});
