import { clientsService } from "@/config/clients";
import type { Resolvers } from "@/generated/console/resolvers";
import { type Guards, onTenant } from "../../guard";
import { activeTenant, refusing, tenantArg } from "../catalog-support";
import { keepConsoleClient } from "../reserved";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const clientsGuards: Guards = {
  "Query.clients": view,
  "Query.client": view,
  "Mutation.createClient": edit,
  "Mutation.updateClient": edit,
  "Mutation.rotateClientSecret": edit,
  "Mutation.deleteClient": edit,
};

const TYPE = { public: "PUBLIC", confidential: "CONFIDENTIAL" } as const;

const shape = (client: {
  clientId: string;
  name: string;
  type: "public" | "confidential";
  redirectUris: readonly string[];
  createdAt: Date;
}) => ({
  id: client.clientId,
  name: client.name,
  type: TYPE[client.type],
  redirectUris: [...client.redirectUris],
  createdAt: client.createdAt,
});

const MAX_PAGE = 100;

export const clients: Resolvers = {
  Query: {
    clients: async (_, { tenantId, q, after, first }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const page = await refusing(() =>
        clientsService.list(tenant, {
          after: after ?? null,
          limit: Math.min(Math.max(first ?? 25, 1), MAX_PAGE),
          q: q ?? undefined,
        }),
      );
      return {
        items: page.items.map(shape),
        nextCursor: page.nextCursor,
      };
    },
    client: async (_, { tenantId, id }, ctx) => {
      const found = await clientsService.find(
        await activeTenant(ctx, tenantId),
        id,
      );
      return found === null ? null : shape(found);
    },
  },
  Mutation: {
    createClient: async (_, { tenantId, input }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const created = await refusing(() =>
        clientsService.create(tenant, {
          name: input.name,
          type: input.type === "CONFIDENTIAL" ? "confidential" : "public",
          redirectUris: input.redirectUris,
          clientId: input.clientId ?? undefined,
        }),
      );
      return {
        client: shape(created.client),
        clientSecret: created.clientSecret,
      };
    },
    updateClient: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      return shape(
        await refusing(() => {
          keepConsoleClient(tenant, id);
          return clientsService.update(tenant, id, {
            name: input.name ?? undefined,
            redirectUris: input.redirectUris ?? undefined,
          });
        }),
      );
    },
    rotateClientSecret: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      const rotated = await refusing(() => {
        keepConsoleClient(tenant, id);
        return clientsService.rotateSecret(tenant, id);
      });
      return {
        client: shape(rotated.client),
        clientSecret: rotated.clientSecret,
      };
    },
    deleteClient: async (_, { tenantId, id }, ctx) => {
      const tenant = await activeTenant(ctx, tenantId);
      return refusing(async () => {
        keepConsoleClient(tenant, id);
        return clientsService.delete(tenant, id);
      });
    },
  },
};
