import { createApp } from "@/app";
import { createConsoleDeps } from "@/config/console";
import { CONSOLE_PATH } from "@/console/identity";

export interface ConsoleResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

// The console's wiring with no OAuth server behind it: `authenticate` is
// replaced below, so the token is never verified (console.spec.ts covers that).
const deps = createConsoleDeps({ serverFor: async () => null });

/**
 * The real console API (schema, guards, resolvers, stores) called as the user
 * `userId`, whatever the bearer token: for a module's spec, which grants that
 * user its roles through `access`.
 */
export function consoleAs(userId: string) {
  const app = createApp({
    console: {
      ...deps,
      authenticate: async () => ({
        userId,
        clientId: "spec",
        grantId: "spec",
        scopes: ["console"],
      }),
    },
  });
  return async (
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<ConsoleResult> => {
    const response = await app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer spec",
      },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as ConsoleResult;
  };
}

/** The first error's code, `undefined` when the call succeeded. */
export const codeOf = (result: ConsoleResult) =>
  result.errors?.[0]?.extensions?.code;
