import { describe, expect, test } from "bun:test";
import { pruneWebhookSecrets } from "./secrets-prune";

describe("pruneWebhookSecrets", () => {
  test("sums the pruned endpoints and survives a failing tenant", async () => {
    const logged: string[] = [];
    const report = await pruneWebhookSecrets(
      {
        tenantIds: async () => ["t1", "t2", "t3"],
        prune: async (tenantId) => {
          if (tenantId === "t2") throw new Error("boom");
          return 2;
        },
        log: (message) => logged.push(message),
      },
      new Date(),
    );
    expect(report).toEqual({ pruned: 4, failed: 1 });
    expect(logged).toHaveLength(1);
  });
});
