import { describe, expect, test } from "bun:test";
import { currentUserOf, deviceOptions } from "./auth.utils";

const requestWith = (headers: Record<string, string>) =>
  new Request("https://acme.example/graphql", { headers });

describe("currentUserOf", () => {
  test("keeps the four public fields and nulls a missing name", () => {
    const user = { id: "u1", email: "a@x.test", emailVerified: true };
    expect(currentUserOf({ ...user, secret: "no" } as typeof user)).toEqual({
      ...user,
      name: null,
    });
  });

  test("passes the name through", () => {
    expect(
      currentUserOf({
        id: "u1",
        email: "a@x.test",
        name: "Ada",
        emailVerified: false,
      }).name,
    ).toBe("Ada");
  });
});

describe("deviceOptions", () => {
  test("labels the device with the trimmed User-Agent", () => {
    expect(deviceOptions(requestWith({ "user-agent": " Firefox " }))).toEqual({
      deviceLabel: "Firefox",
    });
  });

  test("gives nothing for no or a blank User-Agent", () => {
    expect(deviceOptions(requestWith({}))).toEqual({});
    expect(deviceOptions(requestWith({ "user-agent": "   " }))).toEqual({});
  });
});
