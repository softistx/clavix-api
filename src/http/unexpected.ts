import { createLogger } from "@softistx/telemetry";

const log = createLogger("graphql");

/** graxia's `onUnexpected`: the original error of an unexpected failure, with its correlation id, to the app's telemetry (graxia's default is silent in production). */
/**
 * The error without its message, which can hold an e-mail (a Mongo E11000), a
 * code or a token: its name, `code`, and the stack from the second line on.
 */
export function scrubbed(error: unknown): Error {
  const source =
    error instanceof Error ? error : new Error(String(typeof error));
  const code = (source as { code?: unknown }).code;
  const safe = new Error(
    `${source.name}${code === undefined ? "" : ` (${String(code)})`}`,
  );
  safe.name = source.name;
  safe.stack = `${source.name}\n${(source.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((l) => l.trimStart().startsWith("at "))
    .join("\n")}`;
  return safe;
}

export const reportUnexpected = (
  error: unknown,
  info: { correlationId: string | undefined; phase: string },
): void => {
  log.error("unexpected graphql error", scrubbed(error), {
    correlationId: info.correlationId,
    phase: info.phase,
  });
};
