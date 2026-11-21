import { describe, expect, it } from "bun:test";
import { InvalidSlugError, SlugTakenError } from "@/modules/tenants";
import { recordOf } from "~/narrow";
import { refusal } from "./refusal";

const extensionsOf = (error: unknown) =>
  recordOf(recordOf(refusal(error), "the refusal")["extensions"], "extensions");

describe("console refusals", () => {
  it("maps the service's refusals and passes anything else through", () => {
    expect(extensionsOf(new SlugTakenError("acme"))["code"]).toBe("SLUG_TAKEN");
    expect(extensionsOf(new InvalidSlugError("x"))["code"]).toBe(
      "BAD_USER_INPUT",
    );
    const other = new Error("boom");
    expect(refusal(other)).toBe(other);
  });
});
