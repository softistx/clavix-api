import { expect, test } from "bun:test";
import { lapsedDomainMail } from "./domains.notice";

test("the lapsed-domain mail names the host, the record and the primary case", () => {
  const input = {
    to: ["o@acme.com"],
    from: { name: "Clavix", address: "no-reply@clavix.test" },
    tenantName: "Acme <script>",
    host: "auth.acme.com",
    txtToken: "clavix-verify=abc",
  };
  const primary = lapsedDomainMail({ ...input, wasPrimary: true });
  expect(primary.to).toEqual(["o@acme.com"]);
  expect(JSON.stringify(primary)).toContain("_clavix.auth.acme.com");
  expect(JSON.stringify(primary)).toContain("primary");
  expect(primary.html).not.toContain("<script>");
});
