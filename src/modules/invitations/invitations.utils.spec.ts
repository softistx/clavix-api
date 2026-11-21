import { describe, expect, test } from "bun:test";
import { toPending } from "./invitations.utils";

describe("toPending", () => {
  test("renames the stored dates and keeps the rest", () => {
    const createdAt = new Date(Date.UTC(2026, 0, 1));
    const expiresAt = new Date(Date.UTC(2026, 0, 8));
    expect(
      toPending({
        id: "1",
        email: "a@inv.test",
        role: "member",
        createdAt,
        updatedAt: new Date(Date.UTC(2026, 0, 3)),
        expiresAt,
        invitedBy: "u1",
      }),
    ).toEqual({
      id: "1",
      email: "a@inv.test",
      role: "member",
      invitedAt: createdAt,
      expiresAt,
      invitedBy: "u1",
    });
  });
});
