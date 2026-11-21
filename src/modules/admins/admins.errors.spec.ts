import { describe, expect, it } from "bun:test";
import { ResendRefusedError } from "@/modules/invitations";
import { alreadyMember, lastOwnerError, refusing } from "./admins.errors";

describe("admins errors", () => {
  it("refuses the loss of the last owner, of a tenant or of the platform", () => {
    const tenant = lastOwnerError();
    expect(tenant.extensions["code"]).toBe("LAST_OWNER");
    expect(tenant.message).toBe("A tenant keeps at least one owner");
    expect(lastOwnerError("platform").message).toBe(
      "A platform keeps at least one owner",
    );
  });

  it("refuses a second role for a member", () => {
    const error = alreadyMember();
    expect(error.extensions["code"]).toBe("ALREADY_MEMBER");
    expect(error.message).toBe("Already an admin of this tenant");
  });

  it("words a refused resend and passes anything else through", async () => {
    const caught = await refusing(async () => {
      throw new ResendRefusedError("RESEND_TOO_SOON", 30);
    }).catch((error: unknown) => error);
    expect(
      (caught as { extensions: { code: string } }).extensions["code"],
    ).toBe("RESEND_TOO_SOON");
    await expect(
      refusing(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await refusing(async () => 7)).toBe(7);
  });
});
