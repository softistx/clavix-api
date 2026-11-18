import { ObjectId } from "mongodb";
import { planOf } from "@/modules/tenants/plan.schema";
import { CONSOLE_EXPORT_PATH } from "../identity";
import { authenticated, type ConsoleDeps, refusal } from "../plugin";
import { csvLine } from "./format";

/** D17: an export holds at most this many rows (the newest ones). */
export const EXPORT_MAX_ROWS = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGS = ["admin", "auth"] as const;
const FORMATS = ["csv", "ndjson"] as const;

type Log = (typeof LOGS)[number];
type Format = (typeof FORMATS)[number];

const ADMIN_COLUMNS = [
  "id",
  "at",
  "action",
  "actor",
  "targetType",
  "targetId",
  "tenantId",
  "requestId",
] as const;
const AUTH_COLUMNS = [
  "id",
  "at",
  "type",
  "outcome",
  "reason",
  "method",
  "actorKind",
  "actorId",
  "userId",
  "clientId",
  "ip",
  "userAgent",
  "requestId",
] as const;

type Row = Record<string, string | null>;

const bad = (message: string) => refusal(400, "BAD_USER_INPUT", message);
const forbidden = () => refusal(403, "FORBIDDEN", "Not allowed");

const dateParam = (value: string | null) => {
  if (value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * `GET /console/audit/export` (D17): one tenant's console activity (`log=admin`,
 * `view`) or sign-in log (`log=auth`, `edit`: it holds addresses, D18) as CSV
 * or NDJSON, streamed from the store a batch at a time. The caller is
 * authenticated like the GraphQL API (Bearer or DPoP, console client, verified
 * e-mail). The range is cut to the tenant's retention, an export holds at most
 * 100 000 rows (the newest; `x-clavix-export-truncated` says so), CSV cells are
 * guarded against formula injection, and the admin event `auditLog.export` is
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

  const query = new URL(request.url).searchParams;
  const tenantId = query.get("tenantId") ?? "";
  const log = query.get("log") as Log | null;
  const format = (query.get("format") ?? "csv") as Format;
  if (!ObjectId.isValid(tenantId)) return bad("tenantId is not a tenant id");
  if (log === null || !LOGS.includes(log)) return bad("log is admin or auth");
  if (!FORMATS.includes(format)) return bad("format is csv or ndjson");
  const from = dateParam(query.get("from"));
  const to = dateParam(query.get("to"));
  if (from === undefined || to === undefined) {
    return bad("from and to are ISO 8601 dates");
  }
  if (from !== null && to !== null && from > to) {
    return bad("from is after to");
  }

  // Role first, so a caller with no right learns nothing of the tenant (D18).
  if (
    !(await deps.access.can(userId, log === "auth" ? "edit" : "view", tenantId))
  ) {
    return forbidden();
  }
  const [tenant] = await deps.directory.tenantsByIds([tenantId]);
  if (tenant === undefined) {
    return refusal(404, "NOT_FOUND", "No such tenant");
  }

  // The range stays inside the retention (D17): older rows are gone or about to be.
  const now = (deps.auditExport?.now ?? (() => new Date()))();
  const floor = new Date(
    now.getTime() - planOf(tenant.plan).auditRetentionDays * DAY_MS,
  );
  const start = from === null || from < floor ? floor : from;
  const maxRows = deps.auditExport?.maxRows ?? EXPORT_MAX_ROWS;

  const filter = { from: start, to };
  const adminScope = { tenantId };
  const total =
    log === "admin"
      ? await deps.activity.admin.count(adminScope, filter)
      : await deps.activity.auth.count(tenantId, filter);
  const rows = Math.min(total, maxRows);

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

  const columns = log === "admin" ? ADMIN_COLUMNS : AUTH_COLUMNS;
  const source: AsyncIterable<Row> =
    log === "admin"
      ? mapRows(
          deps.activity.admin.stream(adminScope, filter, maxRows),
          (e) => ({
            id: e._id.toHexString(),
            at: e.at.toISOString(),
            action: e.action,
            actor: e.actor,
            targetType: e.target.type,
            targetId: e.target.id,
            tenantId: e.tenantId?.toHexString() ?? null,
            requestId: e.requestId,
          }),
        )
      : mapRows(deps.activity.auth.stream(tenantId, filter, maxRows), (e) => ({
          id: e._id.toHexString(),
          at: e.at.toISOString(),
          type: e.type,
          outcome: e.outcome,
          reason: e.reason,
          method: e.method,
          actorKind: e.actor.kind,
          actorId: e.actor.id,
          userId: e.userId,
          clientId: e.clientId,
          ip: e.ip,
          userAgent: e.userAgent,
          requestId: e.requestId,
        }));

  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  let header = format === "csv";
  const body = new ReadableStream<Uint8Array>({
    // One row per pull: the stream's own backpressure keeps memory flat.
    async pull(controller) {
      if (header) {
        header = false;
        controller.enqueue(encoder.encode(csvLine(columns)));
        return;
      }
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(
        encoder.encode(
          format === "csv"
            ? csvLine(columns.map((column) => next.value[column] ?? null))
            : `${JSON.stringify(next.value)}\n`,
        ),
      );
    },
    async cancel() {
      await iterator.return?.();
    },
  });

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
      "x-clavix-export-rows": String(rows),
      "x-clavix-export-truncated": String(total > maxRows),
    },
  });
}

async function* mapRows<T>(
  source: AsyncIterable<T>,
  row: (item: T) => Row,
): AsyncGenerator<Row> {
  for await (const item of source) yield row(item);
}
