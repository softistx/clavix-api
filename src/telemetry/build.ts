import {
  alwaysSample,
  createTelemetry,
  type Exporter,
  ratioSampler,
  type Telemetry,
} from "@softistx/telemetry";
import { otlpExporter } from "@softistx/telemetry-otlp";
import { parseOtlpHeaders } from "./otlp-headers";
import { withoutAddresses } from "./scrub";

/** The service name every signal groups by. */
export const SERVICE = "clavix-api";

/** The share of traces kept in production (D24); logs are never sampled. */
export const PRODUCTION_SAMPLE_RATIO = 0.1;

export interface ClavixTelemetryOptions {
  version: string;
  production: boolean;
  /** The collector's base URL (`OTEL_EXPORTER_OTLP_ENDPOINT`); unset, nothing is exported. */
  endpoint?: string | undefined;
  /** The collector's headers (`OTEL_EXPORTER_OTLP_HEADERS`). */
  headers?: string | undefined;
  /** More exporters, e.g. an in-memory one in a spec. */
  exporters?: readonly Exporter[];
}

/**
 * The telemetry of the API (D24): OTLP/HTTP when an endpoint is set, otherwise
 * no exporter at all, so nothing is sent and nothing can fail. Not installed:
 * the caller decides (`config/telemetry.ts` installs the app's).
 */
export function buildTelemetry(options: ClavixTelemetryOptions): Telemetry {
  const exporters = [
    ...(options.endpoint === undefined
      ? []
      : [
          otlpExporter({
            endpoint: options.endpoint,
            headers: parseOtlpHeaders(options.headers),
          }),
        ]),
    ...(options.exporters ?? []),
  ].map(withoutAddresses);
  return createTelemetry(SERVICE, {
    version: options.version,
    environment: options.production ? "production" : "development",
    sampler: options.production
      ? ratioSampler(PRODUCTION_SAMPLE_RATIO)
      : alwaysSample,
    exporters,
  });
}
