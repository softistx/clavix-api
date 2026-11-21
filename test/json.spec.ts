import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { errorBody, jsonOf, tokenBody } from "~/json";

const respond = (body: unknown) => new Response(JSON.stringify(body));

describe("jsonOf", () => {
  test("returns the body parsed by the schema", async () => {
    const body = await jsonOf(respond({ n: 2 }), z.object({ n: z.number() }));
    expect(body.n).toBe(2);
  });

  test("throws on a body the schema does not describe", async () => {
    await expect(
      jsonOf(respond({ n: "2" }), z.object({ n: z.number() })),
    ).rejects.toThrow();
  });
});

describe("tokenBody", () => {
  test("needs an access token and keeps unknown fields", () => {
    const body = tokenBody.parse({ access_token: "a", extra: 1 });
    expect(body).toMatchObject({ access_token: "a", extra: 1 });
    expect(() => tokenBody.parse({ id_token: "i" })).toThrow();
  });

  test("allows a null refresh token", () => {
    expect(
      tokenBody.parse({ access_token: "a", refresh_token: null }).refresh_token,
    ).toBeNull();
  });
});

describe("errorBody", () => {
  test("needs the error code", () => {
    expect(errorBody.parse({ error: "invalid_grant" }).error).toBe(
      "invalid_grant",
    );
    expect(() => errorBody.parse({ error_description: "x" })).toThrow();
  });
});
