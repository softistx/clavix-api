/** `SIGN_IN_CODE_LIFESPAN` ("10m") in milliseconds; auth.sign-in.spec.ts checks they agree. */
export const SIGN_IN_CODE_LIFESPAN_MS = 10 * 60_000;

/** `MAGIC_LINK_LIFESPAN` ("15m") in milliseconds; auth.magic-link.spec.ts checks they agree. */
export const MAGIC_LINK_LIFESPAN_MS = 15 * 60_000;

/** The `CurrentUser` the API answers for a janus user. */
export const currentUserOf = (user: {
  id: string;
  email: string;
  name?: string | undefined;
  emailVerified: boolean;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name ?? null,
  emailVerified: user.emailVerified,
});

/**
 * What a sign-in records as its session's device in the console's session
 * list: the request's User-Agent, or nothing without one. janus cuts it at 256
 * characters.
 */
export function deviceOptions(request: Request): { deviceLabel?: string } {
  const agent = request.headers.get("user-agent")?.trim();
  return agent === undefined || agent === "" ? {} : { deviceLabel: agent };
}
