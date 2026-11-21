import { expect, test } from "bun:test";
import { htmlEscape } from "./html";

test("the five markup characters become numeric references", () => {
  expect(htmlEscape(`<a href="x">&'</a>`)).toBe(
    "&#60;a href=&#34;x&#34;&#62;&#38;&#39;&#60;/a&#62;",
  );
});

test("plain text is left as it is", () => {
  expect(htmlEscape("acme.example")).toBe("acme.example");
});
