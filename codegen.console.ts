import type { CodegenConfig } from "@graphql-codegen/cli";
import { codegenScalars } from "@nxgt/graphql-scalars";

// `bun run generate` also writes the console API's types
// (src/generated/console/resolvers.ts) from src/console/**/*.graphqls and the modules' `*.console.graphqls`, whose
// context is the console's own (`ConsoleContext`, src/console/context.ts).
const config: CodegenConfig = {
  schema: [
    "src/console/**/*.graphqls",
    "src/modules/**/*.console.graphqls",
    "generated/graphql/**/*.graphqls",
  ],
  ignoreNoDocuments: true,
  generates: {
    "src/generated/console/resolvers.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        contextType: "@/console/context#ConsoleContext",
        scalars: codegenScalars,
        useTypeImports: true,
        useIndexSignature: true,
        enumsAsTypes: true,
        // `Me` has no stored document: its fields read the caller.
        mappers: {
          Me: "@/modules/me/me.types#MeParent",
          // A tenant by id, slug and name, and its stored document when read.
          Tenant: "@/modules/tenants/tenants.console-parent#TenantParent",
          // A user with its tenant, for the fields read from its pool.
          TenantUser: "@/modules/users/users.types#TenantUserParent",
          // An endpoint with its tenant, which its `deliveries` read through.
          WebhookEndpoint:
            "@/modules/webhooks/webhooks.console-parent#WebhookEndpointParent",
        },
      },
    },
  },
};

export default config;
