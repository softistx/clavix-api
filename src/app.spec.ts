import { expect, test } from "bun:test";
import { graphqlClient } from "@softistx/alxia-graphql/testing";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { graphql } from "~/generated/graphql";
import { version } from "./modules/health";

const app = createTestApp();

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
  const result = await graphqlClient(app, { headers: clientHeaders }).query(
    Health,
  );
  expect(result.data?.health).toEqual({
    status: "ok",
    version,
  });
});

// The page runs a third-party script on the origin that holds the session
// cookie: it is never served unless the IDE is switched on (development).
const openIde = (target: ReturnType<typeof createTestApp>) =>
  target.request("http://localhost/graphql", {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
const introspect = async (target: ReturnType<typeof createTestApp>) => {
  const response = await target.request("http://localhost/graphql", {
    method: "POST",
    headers: { ...clientHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      query:
        '{ __schema { queryType { name } } __type(name: "Query") { name } }',
    }),
  });
  return (await response.json()) as {
    data?: unknown;
    errors?: { message: string }[];
  };
};

test("GET /graphql from a browser is not an IDE page by default", async () => {
  const response = await openIde(app);
  const body = await response.text();
  expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  expect(body).not.toContain("apollographql");
  expect(body).not.toContain("<script");
});

test("the hosted schema is not introspected by default", async () => {
  const result = await introspect(app);
  expect(result.data ?? null).toBeNull();
  expect(result.errors?.map((error) => error.message).join(" ")).toContain(
    "introspection",
  );
  // An ordinary query still runs.
  expect(
    (await graphqlClient(app, { headers: clientHeaders }).query(Health)).data
      ?.health.status,
  ).toBe("ok");
});

test("with the IDE switched on (development) the page and introspection are back", async () => {
  const dev = createTestApp({ ide: true });
  const response = await openIde(dev);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect((await introspect(dev)).errors).toBeUndefined();
});
