import { ObjectId } from "mongodb";
import { refusal } from "../plugin";

export const LOGS = ["admin", "auth"] as const;
export const FORMATS = ["csv", "ndjson"] as const;
export type Log = (typeof LOGS)[number];
export type Format = (typeof FORMATS)[number];

export interface ExportParams {
  tenantId: string;
  log: Log;
  format: Format;
  from: Date | null;
  to: Date | null;
}

const bad = (message: string) => refusal(400, "BAD_USER_INPUT", message);
const isLog = (value: string | null): value is Log =>
  LOGS.some((log) => log === value);
const isFormat = (value: string): value is Format =>
  FORMATS.some((format) => format === value);

/** `undefined` for a value that is not a date, `null` for an absent one. */
const dateParam = (value: string | null) => {
  if (value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** The export's query string, or the 400 that refuses it. */
export function parseParams(url: string): ExportParams | Response {
  const query = new URL(url).searchParams;
  const tenantId = query.get("tenantId") ?? "";
  const log = query.get("log");
  const format = query.get("format") ?? "csv";
  if (!ObjectId.isValid(tenantId)) return bad("tenantId is not a tenant id");
  if (!isLog(log)) return bad("log is admin or auth");
  if (!isFormat(format)) return bad("format is csv or ndjson");
  const from = dateParam(query.get("from"));
  const to = dateParam(query.get("to"));
  if (from === undefined || to === undefined) {
    return bad("from and to are ISO 8601 dates");
  }
  if (from !== null && to !== null && from > to) {
    return bad("from is after to");
  }
  return { tenantId, log, format, from, to };
}
