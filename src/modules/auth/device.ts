/**
 * What a sign-in records as its session's device in the console's session
 * list: the request's User-Agent, or nothing without one. janus cuts it at 256
 * characters.
 */
export function deviceOptions(request: Request): { deviceLabel?: string } {
  const agent = request.headers.get("user-agent")?.trim();
  return agent === undefined || agent === "" ? {} : { deviceLabel: agent };
}
