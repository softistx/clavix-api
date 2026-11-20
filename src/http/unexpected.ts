import { createLogger } from "@softistx/telemetry";

const log = createLogger("graphql");

/** graxia's `onUnexpected`: the original error of an unexpected failure, with its correlation id, to the app's telemetry (graxia's default is silent in production). */
export const reportUnexpected = (
  error: unknown,
  info: { correlationId: string | undefined; phase: string },
): void => {
  log.error("unexpected graphql error", error, {
    correlationId: info.correlationId,
    phase: info.phase,
  });
};
