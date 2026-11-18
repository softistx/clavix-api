import { describe, expect, test } from "bun:test";
import { userAgentFamily } from "./user-agent";

describe("userAgentFamily", () => {
  test("names the family, never the whole header", () => {
    expect(
      userAgentFamily(
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe("Firefox");
    expect(
      userAgentFamily(
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome");
    expect(
      userAgentFamily(
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
      ),
    ).toBe("Edge");
    expect(userAgentFamily("curl/8.4.0")).toBe("curl");
  });

  test("an unknown agent is `other`, a missing header is null", () => {
    expect(userAgentFamily("totally-custom/1.0")).toBe("other");
    expect(userAgentFamily(undefined)).toBeNull();
    expect(userAgentFamily("")).toBeNull();
  });
});
