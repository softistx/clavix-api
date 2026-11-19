import { JanusError } from "@softistx/janus";
import { eventBus } from "@/config/events";
import type { Context } from "@/http/context";
import type { AuthMethod } from "@/modules/audit/auth-events.model";

// One id per HTTP request, ours: a client's `x-request-id` is never believed.
const requestIds = new WeakMap<Request, string>();
const requestIdOf = (request: Request) => {
  let id = requestIds.get(request);
  if (id === undefined) {
    id = crypto.randomUUID();
    requestIds.set(request, id);
  }
  return id;
};

/** A short code for why a sign-in was refused: janus's error code, else `error`. */
export const reasonOf = (error: unknown): string => {
  if (error instanceof JanusError) return error.code;
  const code = (error as { extensions?: { code?: unknown } } | null)?.extensions
    ?.code;
  return typeof code === "string" ? code : "error";
};

const sourceOf = (ctx: Context) => ({
  ip: ctx.ip,
  userAgent: ctx.request.headers.get("user-agent") ?? undefined,
  requestId: requestIdOf(ctx.request),
});

/** Records a successful sign-in of `userId` by `method` (D14). Never throws (D13). */
export const recordSignIn = (
  ctx: Context,
  tenantId: string,
  method: AuthMethod,
  userId: string,
) =>
  eventBus.emit({
    kind: "auth",
    tenantId,
    type: "session.signIn",
    outcome: "success",
    method,
    userId,
    ...sourceOf(ctx),
  });

/** Records a sign-out of `userId` (D14). Never throws (D13). */
export const recordSignOut = (ctx: Context, tenantId: string, userId: string) =>
  eventBus.emit({
    kind: "auth",
    tenantId,
    type: "session.signOut",
    outcome: "success",
    userId,
    ...sourceOf(ctx),
  });

/**
 * Runs one sign-in step and records it: a success with the user it signed in,
 * a refusal with its reason (the error is rethrown unchanged). The event is
 * written after the step, and its failure never changes the answer (D13).
 */
export async function recordingSignIn<T>(
  ctx: Context,
  tenantId: string,
  method: AuthMethod,
  run: () => Promise<T>,
  userIdOf: (done: T) => string | null,
): Promise<T> {
  let done: T;
  try {
    done = await run();
  } catch (error) {
    await eventBus.emit({
      kind: "auth",
      tenantId,
      type: "session.signIn",
      outcome: "failure",
      method,
      reason: reasonOf(error),
      ...sourceOf(ctx),
    });
    throw error;
  }
  // `null`: the step ended in a second-factor challenge, which is no sign-in yet.
  const userId = userIdOf(done);
  if (userId !== null) await recordSignIn(ctx, tenantId, method, userId);
  return done;
}
