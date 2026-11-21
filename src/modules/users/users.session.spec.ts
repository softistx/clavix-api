import { describe, expect, test } from "bun:test";
import {
  MAGIC_LINK_LIFESPAN,
  SESSION,
  SESSION_COOKIE,
  SIGN_IN_CODE_LIFESPAN,
} from "./users.session";

describe("the session of a tenant's user", () => {
  test("the cookie is host-only: the __Host- prefix forbids a Domain", () => {
    expect(SESSION_COOKIE).toBe("__Host-clavix-session");
  });

  test("14 days sliding, renewed daily, 30 days at most after sign-in", () => {
    expect(SESSION).toEqual({
      lifespan: "14d",
      renewAfter: "1d",
      absolute: "30d",
    });
  });

  test("a sign-in code lives 10 minutes, a magic link 15", () => {
    expect(SIGN_IN_CODE_LIFESPAN).toBe("10m");
    expect(MAGIC_LINK_LIFESPAN).toBe("15m");
  });
});
