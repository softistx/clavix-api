import type { ReadyReport } from "@/modules/health";

/** `/readyz`: GET only; 503 when Mongo or Redis does not answer (the orchestrator stops routing here). */
export const serveReadyz = async (
  request: Request,
  ready: () => Promise<ReadyReport>,
) => {
  if (request.method !== "GET") return new Response(null, { status: 404 });
  const report = await ready();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
};
