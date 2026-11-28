import { expect, test } from "bun:test";
import { clientRow } from "./oauth-clients";

test("clientRow is a registered client of its partition, listing the scopes given", () => {
  const row = clientRow("c1", "p1", { allowedScopes: ["read"] });
  expect(row).toMatchObject({
    _id: "c1",
    name: "c1",
    partition: "p1",
    source: "registered",
    allowedScopes: ["read"],
  });
  expect(row.defaultScopes).toBeUndefined();
});
