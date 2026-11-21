import { denial } from "@softistx/janus-graphql";
import { clientsService } from "@/config/clients";
import { resourcesService } from "@/config/resources";
import type { Resolvers } from "@/generated/console/resolvers";
import { CatalogError } from "@/modules/resources";
import { catalogTenant, refusing } from "../catalog-support";
import { keepConsoleClient } from "../reserved";
import { clientsKey, shape, target } from "./shape";

/** Replaces a client's token exchange rules (RFC 8693), under the tenant's client lock. */
export const setClientTokenExchange: NonNullable<
  NonNullable<Resolvers["Mutation"]>["setClientTokenExchange"]
> = async (_, { tenantId, id, input }, ctx) => {
  const tenant = await catalogTenant(ctx, tenantId);
  const listed = input.subjectClients?.length ?? 0;
  const agents = input.subjectAgents === true;
  if (input.anySubjectClient === true ? listed > 0 : listed === 0 && !agents) {
    await refusing(async () => {
      throw new CatalogError(
        "BAD_USER_INPUT",
        input.anySubjectClient === true
          ? "Give subjectClients or anySubjectClient, not both"
          : "Give the clients whose tokens may be exchanged, subjectAgents, or anySubjectClient",
      );
    });
  }
  // Under the tenant's client lock: a delete in between would leave rules
  // of a client that is gone.
  const rules = await ctx.exclusive(clientsKey(tenant), () =>
    refusing(async () => {
      keepConsoleClient(tenant, id);
      const resources = await resourcesService.listResources(tenant._id);
      return clientsService.setTokenExchange(
        tenant,
        id,
        {
          targetResources: input.targetResources,
          subjectClients:
            input.anySubjectClient === true
              ? "any"
              : (input.subjectClients ?? []),
          subjectAgents: agents,
        },
        resources.map((resource) => resource.uri),
      );
    }),
  );
  await ctx.audit("client.tokenExchange.set", target(tenant, id));
  const client = await clientsService.find(tenant, id);
  if (client === null) throw denial("NOT_FOUND", "No such client");
  return shape(client, rules);
};
