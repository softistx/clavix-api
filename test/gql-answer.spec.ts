import { describe, expect, test } from "bun:test";
import { answerOf } from "~/gql-answer";

describe("answerOf", () => {
  test("reads the status, the data and the cookies set", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const answer = await answerOf(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers,
      }),
    );
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ ok: true });
    expect("errors" in answer).toBeFalse();
    expect(answer.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("turns missing data into null and keeps the errors", async () => {
    const answer = await answerOf(
      new Response(JSON.stringify({ errors: [{ message: "no" }] }), {
        status: 400,
      }),
    );
    expect(answer.status).toBe(400);
    expect(answer.data).toBeNull();
    expect(answer.errors).toEqual([{ message: "no" }]);
    expect(answer.cookies).toEqual([]);
  });

  test("rejects a body that is not a GraphQL one", async () => {
    await expect(
      answerOf(new Response(JSON.stringify({ errors: 1 }))),
    ).rejects.toThrow();
  });
});
