import type { CodegenConfig } from "@graphql-codegen/cli";
import { codegenScalars } from "@nxgt/graphql-scalars";

// `bun run generate` also writes the console API's types
// (src/generated/console/resolvers.ts) from src/console/**/*.graphqls, whose
// context is the console's own (`ConsoleContext`, src/console/context.ts).
const config: CodegenConfig = {
  schema: ["src/console/**/*.graphqls", "generated/graphql/**/*.graphqls"],
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
          Me: "@/console/modules/me#MeParent",
          // A tenant by id, slug and name, and its stored document when read.
          Tenant: "@/console/modules/tenants/parent#TenantParent",
          // An endpoint with its tenant, which its `deliveries` read through.
          WebhookEndpoint:
            "@/console/modules/webhooks/parent#WebhookEndpointParent",
        },
      },
    },
  },
};

export default config;
