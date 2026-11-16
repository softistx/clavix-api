import { describe, expect, test } from "bun:test";
import type { TenantJanus } from "@/users/tenant-janus";
import { poolOf } from "./pool";
import { poolUsers } from "./pool-users";

const user = (id: string, email: string, name: string) => ({
  id,
  logins: { email },
  name,
  active: true,
  fields: { email, name },
});

describe("lookup", () => {
  test("asks janus for the e-mail prefix, then the name prefix, each user once, capped", async () => {
    const calls: Record<string, unknown>[] = [];
    const byMail = user("1", "ada@x.test", "Other");
    const both = user("2", "ada.b@x.test", "Ada B");
    const byName = user("3", "zz@x.test", "Ada Lovelace");
    const auth = {
      list: async (filter: Record<string, unknown>) => {
        calls.push(filter);
        const items = "emailPrefix" in filter ? [byMail, both] : [both, byName];
        return { items, nextCursor: null };
      },
    } as unknown as TenantJanus;
    const users = poolUsers(
      poolOf({
        janusOf: async () => auth,
        grantsOf: async () => null,
        invitationsOf: () => {
          throw new Error("unused");
        },
      }),
    );
    const found = await users.lookup("t", "ada", 3);
    expect(found.map((u) => u.id)).toEqual(["1", "2", "3"]);
    expect(calls).toEqual([
      { limit: 3, emailPrefix: "ada" },
      { limit: 5, namePrefix: "ada" },
    ]);
    expect((await users.lookup("t", "ada", 2)).map((u) => u.id)).toEqual([
      "1",
      "2",
    ]);
    expect(calls).toHaveLength(3);
  });
});
