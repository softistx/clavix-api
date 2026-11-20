import { definePlugin } from "@graxia/core";
import { isJsonAnswer } from "./media";

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

// The body without `extensions.http`: the status and headers are the answer's, not the client's to read.
function withoutHttp(body: unknown): unknown {
  const strip = (one: Body): Body =>
    one?.errors === undefined
      ? one
      : {
          ...one,
          errors: one.errors.map(({ extensions, ...error }) => {
            if (extensions === undefined) return error;
            const { http: _http, ...rest } = extensions;
            return { ...error, extensions: rest };
          }),
        };
  return Array.isArray(body)
    ? (body as Body[]).map(strip)
    : strip(body as Body);
}

/**
 * A graxia plugin that answers a JSON result with the highest status named by
 * an error's `extensions.http.status`, and that error's headers
 * (`Retry-After` of a throttle), and drops `extensions.http` from the body. A
 * result with none is left as graxia made it. Not carried: a `text/event-stream`
 * answer, whose status is sent before any error is known.
 */
export const useErrorStatus = () =>
  definePlugin({
    name: "clavix-error-status",
    async onResponse({ response, setResponse }) {
      if (response.status !== 200) return;
      if (!isJsonAnswer(response.headers.get("content-type"))) return;
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        return;
      }
      const named = httpOf(body).filter(
        (http) => typeof http.status === "number",
      );
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      if (named.length === 0) {
        // No status to carry, but `extensions.http` still never reaches the client.
        if (httpOf(body).length === 0) return;
        setResponse(
          new Response(JSON.stringify(withoutHttp(body)), {
            status: response.status,
            headers,
          }),
        );
        return;
      }
      const top = named.reduce((a, b) =>
        (b.status as number) > (a.status as number) ? b : a,
      );
      for (const [name, value] of Object.entries(
        (top.headers ?? {}) as Record<string, unknown>,
      ))
        headers.set(name, String(value));
      setResponse(
        new Response(JSON.stringify(withoutHttp(body)), {
          status: top.status as number,
          headers,
        }),
      );
    },
  });
