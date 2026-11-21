import { expect, test } from "bun:test";
import { CliInputError } from "@/shared/cli";
import { parseRotateArgs } from "./cli";

test("keys:rotate takes a slug or --all, and --drop-old", () => {
  expect(parseRotateArgs(["acme"])).toEqual({
    all: false,
    slug: "acme",
    dropOld: false,
  });
  expect(parseRotateArgs(["acme", "--drop-old"])).toEqual({
    all: false,
    slug: "acme",
    dropOld: true,
  });
  expect(parseRotateArgs(["--all"])).toEqual({ all: true, dropOld: false });
});

test("keys:rotate refuses a missing, doubled or unknown argument", () => {
  for (const bad of [
    [],
    ["a", "b"],
    ["--all", "acme"],
    ["--nope"],
    ["--drop-old"],
  ]) {
    expect(() => parseRotateArgs(bad)).toThrow(CliInputError);
  }
});
