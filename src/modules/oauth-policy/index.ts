// The module's import surface. `oauth-policy.schema` is imported by file by the
// tenants model and service and by `tenancy/resolved-tenant.ts` (the barrel
// would close a cycle through the tenants service), and
// `oauth-policy.console-resolver` by `console/modules/index.ts`.

export {
  type AgentsPolicy,
  agentsOff,
  oauthPolicySchema,
} from "./oauth-policy.schema";
export * from "./oauth-policy.service";
