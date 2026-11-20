import { describe, expect, test } from "bun:test";
import type { SocialProfile } from "@softistx/janus";
import { unverifiedHolderOf } from "./tenant-janus";

const holder = { id: "u1", type: "customer" } as const;
const profile = (provider: string) =>
  ({ provider, accountId: "a1", email: "ada@example.test" }) as SocialProfile;

describe("unverifiedHolderOf (nxgt-janus #978)", () => {
  const decide = unverifiedHolderOf((name) =>
    ["google", "github", "microsoft"].includes(name),
  );

  test("a built-in social app's proof replaces an unverified holder", async () => {
    for (const provider of ["google", "github", "microsoft"]) {
      expect(await decide(holder, profile(provider))).toBe("replace");
    }
  });

  test("an enterprise connection never does", async () => {
    expect(await decide(holder, profile("acme"))).toBe("refuse");
    expect(await decide(holder, profile("hasOwnProperty"))).toBe("refuse");
  });
});
