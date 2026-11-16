import { createApp } from "@/app";
import { createConsoleDeps } from "@/config/console";
import type { ConsoleDirectory } from "@/console/context";
import { CONSOLE_PATH } from "@/console/identity";

export interface ConsoleResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

// The console's wiring with no OAuth server behind it: `authenticate` is
// replaced below, so the token is never verified (console.spec.ts covers that).
const deps = createConsoleDeps({ serverFor: async () => null });

/**
 * The console's wiring with every caller's e-mail counted as proved (ADR-0041),
 * for the specs that act as ids that are no stored user.
 */
export function verifiedCallers<D extends { directory: ConsoleDirectory }>(
  wiring: D,
): D {
  return {
    ...wiring,
    directory: { ...wiring.directory, emailVerified: async () => true },
  };
}

/**
 * The real console API (schema, guards, resolvers, stores) called as the user
 * `userId`, whatever the bearer token: for a module's spec, which grants that
 * user its roles through `access`. `verified: false` plays a caller whose
 * e-mail is not proved.
 */
export function consoleAs(
  userId: string,
  { verified = true }: { verified?: boolean } = {},
) {
  const app = createApp({
    console: {
      ...deps,
      // The caller's e-mail counts as proved (ADR-0041), though many specs
      // act as ids that are no stored user; console.spec.ts covers the gate.
      directory: { ...deps.directory, emailVerified: async () => verified },
      authenticate: async () => ({
        userId,
        clientId: "spec",
        grantId: "spec",
        scopes: ["console"],
        clientName: null,
        bound: null,
        jkt: null,
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
