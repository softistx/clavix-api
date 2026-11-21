import type { Resolvers } from "@/generated/console/resolvers";
import { auditQueries } from "./audit.console-queries";

export { auditAudits, auditGuards } from "./audit.console-guards";

export const audit: Resolvers = { Query: auditQueries };
