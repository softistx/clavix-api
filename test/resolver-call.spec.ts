import { describe, expect, test } from "bun:test";
import { GraphQLString } from "graphql";
import { callResolver, resolveInfo } from "~/resolver-call";

describe("callResolver", () => {
  test("runs the function form with parent, args, context and info", async () => {
    const seen: unknown[] = [];
    const result = await callResolver<
      string,
      { p: number },
      { c: number },
      { a: number }
    >(
      (parent, args, ctx, info) => {
        seen.push(parent, args, ctx, info);
        return "done";
      },
      { p: 1 },
      { a: 2 },
      { c: 3 },
    );
    expect(result).toBe("done");
    expect(seen).toEqual([{ p: 1 }, { a: 2 }, { c: 3 }, resolveInfo]);
  });

  test("runs the { resolve } form", async () => {
    const result = await callResolver<number, number, null, null>(
      { resolve: (parent) => parent + 1 },
      1,
      null,
      null,
    );
    expect(result).toBe(2);
  });

  test("passes on what a resolver throws", async () => {
    await expect(
      callResolver<string, null, null, null>(
        async () => {
          throw new Error("refused");
        },
        null,
        null,
        null,
      ),
    ).rejects.toThrow("refused");
  });

  test("fails the spec when there is no resolver", async () => {
    await expect(
      callResolver<string, null, null, null>(undefined, null, null, null),
    ).rejects.toThrow("expected the resolver to be defined");
  });
});

describe("resolveInfo", () => {
  test("is a complete mutation info", async () => {
    expect(resolveInfo.fieldName).toBe("noop");
    expect(resolveInfo.returnType).toBe(GraphQLString);
    expect(resolveInfo.getAbortSignal()).toBeUndefined();
    expect(await resolveInfo.getAsyncHelpers().promiseAll([1, 2])).toEqual([
      1, 2,
    ]);
  });
});
