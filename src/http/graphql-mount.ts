import { graphql } from "@softistx/alxia-graphql";
import {
  guardSchema,
  type LimixGraxiaOptions,
  limixGraxia,
} from "@softistx/limix-graxia";
import { hostedLimix } from "@/authz/options";
import { janusMasking, janusPlugin } from "@/modules/auth/auth.plugin";
import type {
  AgentsFor,
  DetailTextsFor,
  ScopeTextsFor,
} from "@/modules/consent";
import { oauthContext } from "@/modules/consent/consent.plugin";
import type { OAuthHandle } from "../oauth/routes";
import { useWithoutQuotedValues } from "./coercion";
import type { Base } from "./context";
import { CLIENT_HEADER, useClientHeader } from "./csrf";
import { useSameOriginJson } from "./same-origin";
import { schema } from "./schema";
import { reportUnexpected } from "./unexpected";

/** What the hosted `/graphql` mount reads of the app's options. */
export interface HostedGraphqlOptions {
  /** The GraphQL IDE (Apollo Sandbox) and introspection. */
  ide: boolean;
  /** Refuse a request without `x-clavix-client`. */
  requireClientHeader: boolean;
  /** The OAuth endpoints, when mounted: their `serverFor` gives the consent context. */
  oauth?: Pick<OAuthHandle, "serverFor"> | undefined;
  scopeTexts: ScopeTextsFor;
  detailTexts: DetailTextsFor;
  agents: AgentsFor;
  /** Spec seam: other limix options than `hostedLimix` (a spec that runs the resolvers alone). */
  limix?: LimixGraxiaOptions<object>;
}

/**
 * Mounts the hosted pages' `/graphql` (the schema of `./schema`): the IDE and
 * introspection follow `ide`, the client header is required when asked, and the
 * consent context is added when the OAuth endpoints are mounted.
 */
export function mountHostedGraphql(app: Base, options: HostedGraphqlOptions) {
  const { ide, oauth } = options;
  const limix = options.limix ?? hostedLimix;
  return graphql(app, {
    // Limix: every root field answers to the rules of src/authz (the resolvers keep their guards).
    schema: guardSchema(schema, limix),
    ide: ide ? "apollo-sandbox" : false,
    sandbox: { initialHeaders: { [CLIENT_HEADER]: "apollo-sandbox" } },
    // Introspection follows the IDE: off wherever the IDE is.
    introspection: ide,
    onUnexpected: reportUnexpected,
    plugins: [
      useClientHeader(options.requireClientHeader),
      useSameOriginJson(),
      useWithoutQuotedValues(),
      janusPlugin(),
      limixGraxia(limix),
      ...(oauth?.serverFor === undefined
        ? []
        : [
            oauthContext(
              { serverFor: oauth.serverFor },
              options.scopeTexts,
              options.detailTexts,
              options.agents,
            ),
          ]),
    ],
    ...janusMasking,
  });
}
