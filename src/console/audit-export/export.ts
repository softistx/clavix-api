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
import { parseParams } from "./params";

/** D17: an export holds at most this many rows (the newest ones). */
export const EXPORT_MAX_ROWS = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `GET /console/audit/export` (D17): one tenant's console activity (`log=admin`,
 * `view`) or sign-in log (`log=auth`, `edit`: it holds addresses, D18; on the
 * `clavix` tenant the platform's `edit`, as the GraphQL guard asks) as CSV
 * or NDJSON, streamed from the store a batch at a time. The caller is
 * authenticated like the GraphQL API (Bearer or DPoP, console client, verified
 * e-mail). The range is cut to the tenant's retention, an export holds at most
 * 100 000 rows (the newest; `x-clavix-export-truncated` says so), the tenant
 * has a small export budget (429), and the admin event `auditLog.export` is
 * recorded, awaited, before the first byte.
 */
export async function serveAuditExport(
  request: Request,
  deps: ConsoleDeps,
): Promise<Response> {
  if (request.method !== "GET") {
    return refusal(405, "METHOD_NOT_ALLOWED", "Use GET", { allow: "GET" });
  }
  const principal = await authenticated(
    deps.authenticate,
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
  const { tenantId, log, format, from, to } = params;

  // Role first, so a caller with no right learns nothing of the tenant (D18).
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

  // The range stays inside the retention (D17): older rows are gone or about to be.
  const now = deps.now();
  const retention = planOf(tenant.plan).auditRetentionDays * DAY_MS;
  const floor = new Date(now.getTime() - retention);
  const start = from === null || from < floor ? floor : from;
  const maxRows = deps.auditExport?.maxRows ?? EXPORT_MAX_ROWS;
  const filter = { from: start, to };
  const scope = { tenantId };
  const truncated =
    log === "admin"
      ? await deps.activity.admin.exceeds(scope, filter, maxRows)
      : await deps.activity.auth.exceeds(tenantId, filter, maxRows);

  // The export is on the record before it leaves: a failure to record is no export.
  try {
    await deps.adminEvents.record({
      actor: userId,
      action: "auditLog.export",
      tenantId,
      target: { type: "auditLog", id: log },
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    console.error("console: audit export not recorded", error);
    return refusal(503, "SERVICE_UNAVAILABLE", "Try again later");
  }

  const body =
    log === "admin"
      ? exportBody(
          mapRows(deps.activity.admin.stream(scope, filter, maxRows), adminRow),
          ADMIN_COLUMNS,
          format,
        )
      : exportBody(
          mapRows(
            deps.activity.auth.stream(tenantId, filter, maxRows),
            authRow,
          ),
          AUTH_COLUMNS,
          format,
        );
  const day = now.toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="clavix-${log}-events-${tenant.slug}-${day}.${format}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-clavix-export-from": start.toISOString(),
      "x-clavix-export-truncated": String(truncated),
    },
  });
}
