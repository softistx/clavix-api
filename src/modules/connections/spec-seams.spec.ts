import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// `useFetch` and `useHostResolver` are specs-only seams of ConnectionsService:
// nothing outside a spec (config, env, server) may call them, so production
// always uses janus's guarded transport and real DNS. The facade only passes
// the two setters on to the sign-in service that holds them.
const FACADE = "src/modules/connections/services/connections.service.ts";
describe("connections specs-only seams", () => {
  test("no production file calls useFetch or useHostResolver", async () => {
    const callers: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (file.endsWith(".spec.ts") || file === FACADE) continue;
      const text = await Bun.file(file).text();
      if (/\.(useFetch|useHostResolver)\(/.test(text)) callers.push(file);
    }
    expect(callers).toEqual([]);
  });
});
