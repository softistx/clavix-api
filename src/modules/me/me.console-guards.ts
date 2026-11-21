import { aboutCaller, type Guards } from "@/console/guard";

export const meGuards: Guards = { "Query.me": aboutCaller() };
