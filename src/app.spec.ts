import { expect, test } from "bun:test";
import { graphqlClient } from "@alxia/graphql/testing";
import { graphql } from "~/generated/graphql";
import { createApp } from "./app";
import { version } from "./modules/health";

const app = createApp();

const Health = graphql(`
  query Health {
    health {
      status
      version
    }
  }
`);

test("GET /healthz answers ok and the version", async () => {
  const response = await app.request("/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", version });
});

test("Query.health answers ok and the version through /graphql", async () => {
  const result = await graphqlClient(app).query(Health);
  expect(result.data?.health).toEqual({
    status: "ok",
    version,
  });
});
