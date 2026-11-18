import type { Resolvers } from "@/generated/console/resolvers";
import { auditQueries } from "./queries";

export { auditAudits, auditGuards } from "./guards";

export const audit: Resolvers = { Query: auditQueries };
