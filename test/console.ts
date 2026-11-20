import { createApp } from "@/app";
import { createConsoleDeps } from "@/config/console";
import type { ConsoleBudgets } from "@/console/budgets";
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
 * `userId`, whatever the bearer token, answering the HTTP response (status and
 * headers). `verified: false` plays a caller whose e-mail is not proved;
 * `budgets` gives the console its budgets (none by default: specs have no Redis).
 */
export function consoleRequestAs(
  userId: string,
  {
    verified = true,
    budgets,
  }: { verified?: boolean; budgets?: ConsoleBudgets } = {},
) {
  const app = createApp({
    console: {
      ...deps,
      budgets,
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
        authorizationDetails: [],
      }),
    },
  });
  return (query: string, variables: Record<string, unknown> = {}) =>
    app.request(`http://localhost${CONSOLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer spec",
      },
      body: JSON.stringify({ query, variables }),
    });
}

/**
 * `consoleRequestAs`, answering the parsed body: for a module's spec, which
 * grants that user its roles through `access`.
 */
export function consoleAs(
  userId: string,
  options: { verified?: boolean; budgets?: ConsoleBudgets } = {},
) {
  const request = consoleRequestAs(userId, options);
  return async (
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<ConsoleResult> =>
    (await (await request(query, variables)).json()) as ConsoleResult;
}

/** The first error's code, `undefined` when the call succeeded. */
export const codeOf = (result: ConsoleResult) =>
  result.errors?.[0]?.extensions?.code;

/**
 * `GET /console/audit/export` called as the user `userId` (same stand-in token
 * as `consoleAs`); `auditExport` overrides the row limit or the clock.
 */
export function exportAs(
  userId: string,
  auditExport?: {
    maxRows?: number;
    now?: () => Date;
    throttle?: (tenantId: string) => Promise<number | null>;
  },
) {
  const app = createApp({
    console: {
      ...deps,
      directory: { ...deps.directory, emailVerified: async () => true },
      ...(auditExport === undefined ? {} : { auditExport }),
      authenticate: async () => ({
        userId,
        clientId: "spec",
        grantId: "spec",
        scopes: ["console"],
        clientName: null,
        bound: null,
        jkt: null,
        authorizationDetails: [],
      }),
    },
  });
  return (params: Record<string, string>, headers: HeadersInit = {}) =>
    app.request(
      `http://localhost/console/audit/export?${new URLSearchParams(params)}`,
      { headers: { authorization: "Bearer spec", ...headers } },
    );
}
