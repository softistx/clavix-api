import { eventBus } from "@/config/events";
import type { Context } from "@/http/context";
import type { AuthMethod } from "@/modules/audit/auth-events.model";
import { reasonOf, sourceOf } from "@/modules/auth/auth.events";

/** The audit record of a step-up (D14), success or refusal. Never throws (D13). */
export async function recordStepUp(
  ctx: Context,
  method: AuthMethod,
  userId: string,
  failure?: unknown,
) {
  const tenant = await ctx.tenant();
  if (tenant === null) return;
  await eventBus.emit({
    kind: "auth",
    tenantId: tenant.tenantId,
    type: "stepUp.confirm",
    outcome: failure === undefined ? "success" : "failure",
    ...(failure === undefined ? {} : { reason: reasonOf(failure) }),
    method,
    userId,
    ...sourceOf(ctx),
  });
}
