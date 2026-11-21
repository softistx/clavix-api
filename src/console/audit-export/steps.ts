import { planOf } from "@/modules/tenants";
import { permitted } from "../guard";
import { CONSOLE_EXPORT_PATH } from "../identity";
import type { Permission } from "../model";
import { authenticated, type ConsoleDeps, refusal } from "../plugin";
import { exportBody } from "./body";
import {
  ADMIN_COLUMNS,
  AUTH_COLUMNS,
  adminRow,
  authRow,
  mapRows,
} from "./columns";
import { type ExportParams, parseParams } from "./params";

const DAY_MS = 24 * 60 * 60 * 1000;

type Tenant = NonNullable<
  Awaited<ReturnType<ConsoleDeps["directory"]["tenantsByIds"]>>[number]
>;

/** A range of the export: the retention-bound start and the caller's end. */
export interface ExportFilter {
  readonly from: Date;
  readonly to: Date | null;
}

/** What a caller who may export is: who, which tenant, which request. */
export interface ExportAccess {
  readonly userId: string;
  readonly tenant: Tenant;
  readonly params: ExportParams;
}

/**
 * The checks before any byte: method, caller, verified e-mail, parameters,
 * role (first, so a caller with no right learns nothing of the tenant, D18),
 * tenant, export budget. A refusal is the `Response` to send.
 */
export async function authorize(
  request: Request,
  deps: ConsoleDeps,
): Promise<Response | ExportAccess> {
  if (request.method !== "GET") {
    return refusal(405, "METHOD_NOT_ALLOWED", "Use GET", { allow: "GET" });
  }
  const principal = await authenticated(
    deps.authenticate,
    deps.reportError,
    request,
    CONSOLE_EXPORT_PATH,
  );
  if (principal instanceof Response) return principal;
  const userId = principal.userId;
  if (!(await deps.directory.emailVerified(userId))) {
    return refusal(403, "EMAIL_UNVERIFIED", "Verify your e-mail address first");
  }
  const params = parseParams(request.url);
  if (params instanceof Response) return params;
  const { tenantId, log } = params;

  // The same rule as the GraphQL guard (`permitted`): the sign-in log of the
  // `clavix` tenant (`edit`) is the platform's, not a tenant-level role's.
  const permission = log === "auth" ? "edit" : "view";
  const [tenant] = await deps.directory.tenantsByIds([tenantId]);
  const who = {
    can: (wanted: Permission, id: string) =>
      deps.access.can(userId, wanted, id),
    canPlatform: (wanted: Permission) =>
      deps.access.canPlatform(userId, wanted),
  };
  if (!(await permitted(who, permission, tenantId, tenant))) {
    return refusal(403, "FORBIDDEN", "Not allowed");
  }
  if (tenant === undefined) {
    return refusal(404, "NOT_FOUND", "No such tenant");
  }
  const retryAfter = await deps.auditExport?.throttle?.(tenantId);
  if (retryAfter !== undefined && retryAfter !== null) {
    return refusal(429, "RATE_LIMITED", "Too many exports", {
      "retry-after": String(retryAfter),
    });
  }
  return { userId, tenant, params };
}

/** The range stays inside the retention (D17): older rows are gone or about to be. */
export function rangeStart(
  plan: Tenant["plan"],
  from: Date | null,
  now: Date,
): Date {
  const retention = planOf(plan).auditRetentionDays * DAY_MS;
  const floor = new Date(now.getTime() - retention);
  return from === null || from < floor ? floor : from;
}

/** Whether the range holds more rows than the export may. */
export async function exceeds(
  deps: ConsoleDeps,
  params: ExportParams,
  filter: ExportFilter,
  maxRows: number,
): Promise<boolean> {
  const { tenantId, log } = params;
  return log === "admin"
    ? await deps.activity.admin.exceeds({ tenantId }, filter, maxRows)
    : await deps.activity.auth.exceeds(tenantId, filter, maxRows);
}

/**
 * The export is on the record before it leaves: a failure to record is no
 * export. Returns the 503 to send, or nothing once recorded.
 */
export async function recordExport(
  deps: ConsoleDeps,
  userId: string,
  tenantId: string,
  log: string,
): Promise<Response | undefined> {
  try {
    await deps.adminEvents.record({
      actor: userId,
      action: "auditLog.export",
      tenantId,
      target: { type: "auditLog", id: log },
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    deps.reportError("console: audit export not recorded", error);
    return refusal(503, "SERVICE_UNAVAILABLE", "Try again later");
  }
  return undefined;
}

/** The streamed body of the log the caller asked for. */
export function bodyOf(
  deps: ConsoleDeps,
  params: ExportParams,
  filter: ExportFilter,
  maxRows: number,
) {
  const { tenantId, log, format } = params;
  return log === "admin"
    ? exportBody(
        mapRows(
          deps.activity.admin.stream({ tenantId }, filter, maxRows),
          adminRow,
        ),
        ADMIN_COLUMNS,
        format,
      )
    : exportBody(
        mapRows(deps.activity.auth.stream(tenantId, filter, maxRows), authRow),
        AUTH_COLUMNS,
        format,
      );
}
