import type { ConsoleDeps } from "../plugin";
import { authorize, bodyOf, exceeds, rangeStart, recordExport } from "./steps";

/** D17: an export holds at most this many rows (the newest ones). */
export const EXPORT_MAX_ROWS = 100_000;

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
  const allowed = await authorize(request, deps);
  if (allowed instanceof Response) return allowed;
  const { userId, tenant, params } = allowed;
  const { tenantId, log, format } = params;
  const now = deps.now();
  const start = rangeStart(tenant.plan, params.from, now);
  const maxRows = deps.auditExport.maxRows ?? EXPORT_MAX_ROWS;
  const filter = { from: start, to: params.to };
  const truncated = await exceeds(deps, params, filter, maxRows);
  const failure = await recordExport(deps, userId, tenantId, log);
  if (failure !== undefined) return failure;
  const day = now.toISOString().slice(0, 10);
  return new Response(bodyOf(deps, params, filter, maxRows), {
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
