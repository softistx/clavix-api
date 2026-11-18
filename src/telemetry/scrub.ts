import type { Exporter, Signal } from "@softistx/telemetry";

/** The attributes D24 never writes: a client address is an IP. */
const NEVER_WRITTEN = ["client.address"] as const;

function scrubbed<T extends Signal>(signal: T): T {
  if (!NEVER_WRITTEN.some((name) => name in signal.attributes)) return signal;
  const attributes = { ...signal.attributes };
  for (const name of NEVER_WRITTEN) delete attributes[name];
  return { ...signal, attributes };
}

/**
 * The exporter, with the attributes D24 forbids taken off every signal before
 * it leaves the process.
 *
 * Temporary, until @alxia/telemetry#829: the span records the caller's address, and
 * D24 forbids writing IPs.
 */
export function withoutAddresses(exporter: Exporter): Exporter {
  return {
    export: (resource, batch) => exporter.export(resource, batch.map(scrubbed)),
    ...(exporter.close === undefined
      ? {}
      : { close: () => exporter.close?.() }),
  };
}
