import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { hostOf, issuerOf, partitionOf } from "./identity";

test("the issuer is derived from the slug, scheme, domain and port", () => {
  expect(issuerOf("acme", { scheme: "https", domain: "clavix.example" })).toBe(
    "https://acme.clavix.example",
  );
  expect(
    issuerOf("acme", {
      scheme: "http",
      domain: "clavix.localhost",
      port: 3000,
    }),
  ).toBe("http://acme.clavix.localhost:3000");
  expect(hostOf("acme", "clavix.example")).toBe("acme.clavix.example");
});

test("the partition is the id in hex", () => {
  const id = new ObjectId();
  expect(partitionOf(id)).toBe(id.toHexString());
});
