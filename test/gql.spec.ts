import { describe, expect, test } from "bun:test";
import { gqlBody, gqlOf } from "~/gql";

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

describe("gqlOf", () => {
  test("parses the data of a real response", async () => {
    const result = await gqlOf(respond({ data: { me: { id: "1" } } }));
    expect(result.data).toEqual({ me: { id: "1" } });
    expect(result.errors).toBeUndefined();
  });

  test("keeps the errors with their path and extensions", async () => {
    const result = await gqlOf(
      respond({
        data: null,
        errors: [
          {
            message: "no",
            path: ["a", 0],
            extensions: { code: "X", field: "f", missing: ["m"], more: 1 },
          },
        ],
      }),
    );
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.path).toEqual(["a", 0]);
    expect(result.errors?.[0]?.extensions).toMatchObject({
      code: "X",
      field: "f",
      missing: ["m"],
      more: 1,
    });
  });

  test("rejects a body that is not a GraphQL one", async () => {
    await expect(gqlOf(respond({ errors: "boom" }))).rejects.toThrow();
    await expect(gqlOf(respond({ errors: [{ path: [] }] }))).rejects.toThrow();
  });

  test("rejects a body that is not JSON", async () => {
    await expect(gqlOf(new Response("<html>"))).rejects.toThrow();
  });
});

describe("gqlBody", () => {
  test("accepts an empty body", () => {
    expect(gqlBody.parse({})).toEqual({});
  });
});
