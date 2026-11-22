import { expect, spyOn, test } from "bun:test";
import { services } from "@/modules/services";
import { callResolver } from "~/resolver-call";
import { contextOf } from "~/spec-context";
import { media } from "./media.resolver";

test("removeMyPicture answers what the avatars service removed, for the signed-in caller", async () => {
  const ctx = contextOf({});
  for (const removed of [true, false]) {
    const own = spyOn(services().avatars, "removeOwn").mockResolvedValue(
      removed,
    );
    try {
      expect(
        await callResolver(media.Mutation?.removeMyPicture, {}, {}, ctx),
      ).toBe(removed);
      expect(own).toHaveBeenCalledWith(ctx);
    } finally {
      own.mockRestore();
    }
  }
});
