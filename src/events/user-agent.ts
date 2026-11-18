// The family of a User-Agent: enough to tell a browser from a tool in the log,
// not enough to fingerprint a person. Order matters (Edge and Chrome both say Chrome).
const FAMILIES: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/^curl\//i, "curl"],
  [/\bPostman/i, "Postman"],
];

/** The browser or tool family of a User-Agent header; `null` without one, `other` when unknown. */
export function userAgentFamily(header: string | null | undefined) {
  const agent = header?.trim() ?? "";
  if (agent === "") return null;
  return FAMILIES.find(([pattern]) => pattern.test(agent))?.[1] ?? "other";
}
