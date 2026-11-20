import { describe, expect, test } from "bun:test";
import { csvCell, csvLine } from "./format";

describe("csvCell", () => {
  test("a formula start is made text", () => {
    for (const value of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(value).replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });
  test("commas, quotes and line breaks are quoted", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("plain")).toBe("plain");
  });
  test("null is an empty cell", () => {
    expect(csvLine(["a", null, "b"])).toBe("a,,b\r\n");
  });
});
