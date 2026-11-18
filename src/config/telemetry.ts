import { instrumentMongo } from "@softistx/telemetry-mongo";
import { version } from "@/modules/health";
import { buildTelemetry } from "@/telemetry/build";
import { mongo } from "./db";
import { env } from "./env";

/** Whether a collector is configured; the driver's command monitoring is only switched on then (`db.ts`). */
export const tracingOn = env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined;

/**
 * The API's telemetry (D24), installed so every logger and span finds it: OTLP
 * to `OTEL_EXPORTER_OTLP_ENDPOINT`, no exporter without it, 10 % of traces
 * in production.
 */
export const telemetry = buildTelemetry({
  version,
  production: Bun.env.NODE_ENV === "production",
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  headers: env.OTEL_EXPORTER_OTLP_HEADERS,
}).install();

/** One client span per MongoDB command; inert unless a collector is set (see `tracingOn`). */
export const instrumentDatabase = () =>
  tracingOn ? instrumentMongo(mongo.clients.default, { telemetry }) : () => {};
