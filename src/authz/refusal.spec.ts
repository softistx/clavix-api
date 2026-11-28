import { describe, expect, test } from "bun:test";
import type { Refusal } from "@softistx/limix";
import { mapRefusal } from "./refusal";

const at = { type: "Query", field: "me", root: true };
const refusal = (code: string): Refusal => ({ code, status: 0, params: {} });

describe("mapRefusal", () => {
  test("words the limix codes with Clavix's", () => {
    expect(
      mapRefusal(refusal("auth.errors.unauthenticated"), at),
    ).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(mapRefusal(refusal("auth.errors.forbidden"), at)).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(mapRefusal(refusal("auth.errors.not-found"), at)).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(mapRefusal(refusal("limix.errors.unavailable"), at)).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    expect(mapRefusal(refusal("other"), at)).toBeUndefined();
  });
});
