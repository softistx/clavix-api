import { describe, expect, test } from "bun:test";
import {
  checkWebhookUrl,
  guardedFetch,
  parseWebhookUrl,
  type UrlPolicy,
  WebhookUrlError,
} from "./webhooks.url-policy";

const answers = new Map<string, string[]>();
const policy = (allowPrivate = false): UrlPolicy => ({
  allowPrivate,
  resolve: async (host) => {
    const found = answers.get(host);
    if (!found) throw new Error("ENOTFOUND");
    return found;
  },
});
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof WebhookUrlError ? error.code : String(error);
  }
  return "none";
};

describe("parseWebhookUrl", () => {
  test("accepts https", () => {
    expect(parseWebhookUrl("https://hooks.example.com/in").hostname).toBe(
      "hooks.example.com",
    );
  });
  test("refuses http, credentials and junk", () => {
    expect(() => parseWebhookUrl("http://a.example.com")).toThrow(
      WebhookUrlError,
    );
    expect(() => parseWebhookUrl("https://u:p@a.example.com")).toThrow(
      WebhookUrlError,
    );
    expect(() => parseWebhookUrl("not a url")).toThrow(WebhookUrlError);
    expect(() =>
      parseWebhookUrl(`https://a.example.com/${"x".repeat(2000)}`),
    ).toThrow(WebhookUrlError);
  });
});

describe("checkWebhookUrl", () => {
  test("a public name passes", async () => {
    answers.set("ok.example.com", ["93.184.216.34"]);
    await checkWebhookUrl("https://ok.example.com/h", policy());
  });
  test("private, loopback and mixed answers are refused", async () => {
    answers.set("lan.example.com", ["10.0.0.5"]);
    answers.set("mixed.example.com", ["93.184.216.34", "127.0.0.1"]);
    for (const url of [
      "https://lan.example.com",
      "https://mixed.example.com",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest",
      "https://nowhere.example.com",
    ]) {
      expect(await codeOf(checkWebhookUrl(url, policy()))).toBe("notPublic");
    }
  });
  test("allowPrivate lets a private address through, https still required", async () => {
    await checkWebhookUrl("https://127.0.0.1:9000/x", policy(true));
    expect(
      await codeOf(checkWebhookUrl("http://127.0.0.1", policy(true))),
    ).toBe("notHttps");
  });
});

describe("guardedFetch", () => {
  test("re-checks the address on every send (DNS rebinding)", async () => {
    const sent: RequestInit[] = [];
    const send = (async (_url: unknown, init?: RequestInit) => {
      sent.push(init ?? {});
      return new Response("ok");
    }) as unknown as typeof fetch;
    const guarded = guardedFetch(policy(), send);
    answers.set("flip.example.com", ["93.184.216.34"]);
    await guarded("https://flip.example.com/h", { method: "POST" });
    expect(sent[0]?.redirect).toBe("manual");
    answers.set("flip.example.com", ["192.168.1.10"]);
    expect(await codeOf(guarded("https://flip.example.com/h"))).toBe(
      "notPublic",
    );
    expect(sent).toHaveLength(1);
  });
});
