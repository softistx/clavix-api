import { describe, expect, test } from "bun:test";
import { MediaRefusal } from "@softistx/alxia-media";
import { answerOf, codes } from "./media.errors";

const codeOf = (refusal: MediaRefusal) =>
  answerOf(refusal).body.errors[0]?.extensions.code;

describe("media errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("media");
    expect([...codes.codes]).toEqual([
      "MEDIA_UNSUPPORTED_TYPE",
      "MEDIA_TOO_LARGE",
    ]);
  });

  test("each refusal is the API's own code and status", () => {
    const answers = [
      ["unauthenticated", "UNAUTHENTICATED", 401],
      ["forbidden", "FORBIDDEN", 403],
      ["not_found", "NOT_FOUND", 404],
      ["unsupported_type", "MEDIA_UNSUPPORTED_TYPE", 415],
      ["too_large", "MEDIA_TOO_LARGE", 413],
      ["throttled", "RATE_LIMITED", 429],
      ["unavailable", "SERVICE_UNAVAILABLE", 503],
    ] as const;
    for (const [refusal, code, status] of answers) {
      const answer = answerOf(new MediaRefusal(refusal));
      expect(answer.body.errors[0]?.extensions.code).toBe(code);
      expect(answer.status).toBe(status);
    }
  });

  test("a conflict of the app's own is a 409", () => {
    const answer = answerOf(new MediaRefusal("conflict", { status: 409 }));
    expect(answer.status).toBe(409);
    expect(answer.body.errors[0]?.extensions.code).toBe("CONFLICT");
  });

  test("a throttle says when to retry, and no answer is cached", () => {
    const answer = answerOf(new MediaRefusal("throttled", { retryAfter: 42 }));
    expect(answer.headers["retry-after"]).toBe("42");
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answerOf(new MediaRefusal("empty_body")).headers).toEqual({
      "cache-control": "no-store",
    });
  });

  test("any other refusal is a malformed request", () => {
    expect(codeOf(new MediaRefusal("empty_body"))).toBe("BAD_USER_INPUT");
    expect(answerOf(new MediaRefusal("size_mismatch")).status).toBe(400);
  });
});
