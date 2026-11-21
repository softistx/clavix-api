import { BrandingInputError } from "./branding.errors";

// `<` and a backslash are refused anywhere, comments included: the HTML parser
// ends a `<style>` at `</style` inside a comment too. The other tokens are
// looked for once comments are stripped, so `u/**/rl(` cannot hide them.
const UNSAFE_RAW = /<|\\/;
const UNSAFE_TOKENS = /@import|url\(|image-set\(|src\(|image\(|cross-fade\(/i;

/**
 * Refuses a tenant stylesheet that could close the hosted pages' `<style>`,
 * load a resource or hide a token behind an escape: `<`, `@import`, `url(`,
 * `image-set(`, `src(` or a backslash, in any case (`<` and the backslash
 * even inside a comment; the other tokens once comments are stripped). Every write of a tenant's CSS goes through `buildTheme`, which
 * calls it; the UI refuses the same at read (`safeCss`). Throws
 * `BrandingInputError` on field `css`.
 */
export function assertSafeCss(css: string): void {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = UNSAFE_RAW.exec(css) ?? UNSAFE_TOKENS.exec(stripped);
  if (found !== null) {
    throw new BrandingInputError(
      "css",
      `the theme's CSS is not safe: it contains "${found[0].toLowerCase()}", which a tenant stylesheet may not use (no <, @import, url(, image-set(, src( or backslash)`,
    );
  }
}
