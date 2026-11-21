import { describe, expect, test } from "bun:test";
import { disabledEndpointMail } from "./webhooks.notice";

describe("disabledEndpointMail", () => {
  test("names the origin only, never the path", () => {
    const mail = disabledEndpointMail({
      to: ["o@example.com"],
      from: { name: "Clavix", address: "no-reply@example.com" },
      tenantName: "Acme <script>",
      url: "https://hooks.example.com/in/secret-token?x=1",
    });
    expect(mail.subject).toContain("https://hooks.example.com");
    expect(`${mail.text}${mail.html}${mail.subject}`).not.toContain(
      "secret-token",
    );
    expect(mail.html).not.toContain("<script>");
  });
});
