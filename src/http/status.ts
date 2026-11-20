import { definePlugin } from "@graxia/core";

// graxia no longer reads `extensions.http` of an error (Yoga did): this plugin
// gives it back to this API, whose errors carry their status and headers
// (`http: { status: 401 }`, `http: { status: 429, headers: { "retry-after": … } }`).
interface HttpExtension {
  status?: unknown;
  headers?: unknown;
}
interface Body {
  errors?: { extensions?: { http?: HttpExtension } }[];
}

const httpOf = (body: unknown): HttpExtension[] =>
  (Array.isArray(body) ? (body as Body[]) : [body as Body]).flatMap(
    (one) =>
      one?.errors?.flatMap((error) =>
        error.extensions?.http === undefined ? [] : [error.extensions.http],
      ) ?? [],
  );

/**
 * A graxia plugin that answers a JSON result with the highest status named by
 * an error's `extensions.http.status`, and that error's headers
 * (`Retry-After` of a throttle). A result with none is left as graxia made it.
 */
export const useErrorStatus = () =>
  definePlugin({
    name: "clavix-error-status",
    async onResponse({ response, setResponse }) {
      if (response.status !== 200) return;
      if (
        !(response.headers.get("content-type") ?? "").startsWith(
          "application/json",
        )
      )
        return;
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        return;
      }
      const named = httpOf(body).filter(
        (http) => typeof http.status === "number",
      );
      if (named.length === 0) return;
      const top = named.reduce((a, b) =>
        (b.status as number) > (a.status as number) ? b : a,
      );
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(
        (top.headers ?? {}) as Record<string, unknown>,
      ))
        headers.set(name, String(value));
      setResponse(
        new Response(response.body === null ? null : await response.text(), {
          status: top.status as number,
          headers,
        }),
      );
    },
  });
