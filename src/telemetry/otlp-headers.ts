/**
 * `OTEL_EXPORTER_OTLP_HEADERS`: `key=value` pairs separated by commas. A pair
 * with no `=` or an empty key is skipped; the value keeps any `=` it holds
 * (an API key in base64).
 */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const key = pair.slice(0, at).trim();
    if (key !== "") headers[key] = pair.slice(at + 1).trim();
  }
  return headers;
}
