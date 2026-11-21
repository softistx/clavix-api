import { describe, expect, test } from "bun:test";
import {
  codes,
  deviceCodeThrottled,
  refuseIncomplete,
  unmetAuthentication,
} from "./consent.errors";

describe("consent errors", () => {
  test("the module's codes keep their upper-snake values", () => {
    expect(codes.module).toBe("consent");
    expect([...codes.codes]).toEqual([
      "DEVICE_CODE_THROTTLED",
      "UNMET_AUTHENTICATION_REQUIREMENTS",
    ]);
  });

  test("a device throttle is a 429 with Retry-After", () => {
    const error = deviceCodeThrottled(9);
    expect(error.extensions["code"]).toBe("DEVICE_CODE_THROTTLED");
    expect(error.extensions["http"]).toMatchObject({ status: 429 });
  });

  test("an unmet authentication is a 403 that names what is missing", () => {
    const error = unmetAuthentication(["mfa"]);
    expect(error.extensions["code"]).toBe("UNMET_AUTHENTICATION_REQUIREMENTS");
    expect(error.extensions["http"]).toEqual({ status: 403 });
    expect(error.extensions["missing"]).toEqual(["mfa"]);
    expect(error.extensions["oauthError"]).toBe(
      "unmet_authentication_requirements",
    );
  });

  test("incomplete details are an invalid_authorization_details input", () => {
    const error = refuseIncomplete();
    expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions["oauthError"]).toBe(
      "invalid_authorization_details",
    );
  });
});
