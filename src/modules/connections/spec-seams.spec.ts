import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// `useFetch` and `useHostResolver` are specs-only seams of ConnectionSourcesService:
// nothing outside a spec (config, env, server) may call them, so production
// always uses janus's guarded transport and real DNS.
describe("connections specs-only seams", () => {
  test("no production file calls useFetch or useHostResolver", async () => {
    const callers: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (file.endsWith(".spec.ts")) continue;
      const text = await Bun.file(file).text();
      if (/\.(useFetch|useHostResolver)\(/.test(text)) callers.push(file);
    }
    expect(callers).toEqual([]);
  });
});
