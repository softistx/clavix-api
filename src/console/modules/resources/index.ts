import { ObjectId } from "mongodb";
import { clientPoliciesService } from "@/config/client-policies";
import { env } from "@/config/env";
import { resourcesService } from "@/config/resources";
import { rolesService } from "@/config/roles";
import { tenantResolver } from "@/config/tenancy";
import type { Resolvers } from "@/generated/console/resolvers";
import type {
  FieldDraft,
  StoredDetailTypeDoc,
  StoredResourceDoc,
  StoredScopeDoc,
  ValueDraft,
} from "@/modules/resources";
import { protectedResourceDocument } from "@/modules/resources";
import { hostOf } from "@/modules/tenants";
import type { Audits } from "../../audit";
import { type Guards, onTenant } from "../../guard";
import { catalogTenant, refusing } from "../catalog-support";
import { tenantArg } from "../ids";
import { keepConsoleResource, refuseMachineConsole } from "../reserved";

const view = onTenant("view", tenantArg);
const edit = onTenant("edit", tenantArg);

export const resourcesGuards: Guards = {
  "Query.resources": view,
  "Query.resource": view,
  "Query.scopes": view,
  "Mutation.createResource": edit,
  "Mutation.updateResource": edit,
  "Mutation.deleteResource": edit,
  "Mutation.createScope": edit,
  "Mutation.updateScope": edit,
  "Mutation.deleteScope": edit,
  "Mutation.createDetailType": edit,
  "Mutation.updateDetailType": edit,
  "Mutation.deleteDetailType": edit,
};

export const resourcesAudits: Audits = {
  "Mutation.createResource": "resource.create",
  "Mutation.updateResource": "resource.update",
  "Mutation.deleteResource": "resource.delete",
  "Mutation.createScope": "scope.create",
  "Mutation.updateScope": "scope.update",
  "Mutation.deleteScope": "scope.delete",
  "Mutation.createDetailType": "detailType.create",
  "Mutation.updateDetailType": "detailType.update",
  "Mutation.deleteDetailType": "detailType.delete",
};

// What an admin event names: the document's id and its tenant.
const target = (
  type: "resource" | "scope" | "detailType",
  tenantId: ObjectId,
  id: ObjectId,
) => ({
  type,
  id: id.toHexString(),
  tenantId: tenantId.toHexString(),
});

const scopeShape = (scope: StoredScopeDoc) => ({
  id: scope._id.toHexString(),
  name: scope.name,
  description: scope.description,
  resourceId: scope.resourceId?.toHexString() ?? null,
  claims: scope.claims,
});

const KINDS = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  enum: "ENUM",
  "string[]": "STRING_LIST",
} as const;
const KIND_OF = Object.fromEntries(
  Object.entries(KINDS).map(([stored, graphql]) => [graphql, stored]),
) as Record<(typeof KINDS)[keyof typeof KINDS], keyof typeof KINDS>;

const detailTypeShape = (doc: StoredDetailTypeDoc) => ({
  id: doc._id.toHexString(),
  resourceId: doc.resourceId.toHexString(),
  type: doc.type,
  name: doc.name,
  description: doc.description,
  fields: doc.fields.map((field) => ({
    key: field.key,
    kind: KINDS[field.kind],
    label: field.label,
    required: field.required,
    min: field.min ?? null,
    max: field.max ?? null,
    maxLength: field.maxLength ?? null,
    values: field.values ?? null,
  })),
  actions: doc.actions ?? [],
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

type ValueInput = {
  value: string;
  label?: { fr?: string | null; en?: string | null } | null;
};
const valueDraft = (input: ValueInput): ValueDraft => ({
  value: input.value,
  label: {
    fr: input.label?.fr ?? undefined,
    en: input.label?.en ?? undefined,
  },
});

type FieldInput = {
  key: string;
  kind: keyof typeof KIND_OF;
  label?: { fr?: string | null; en?: string | null } | null;
  required?: boolean | null;
  min?: number | null;
  max?: number | null;
  maxLength?: number | null;
  values?: ValueInput[] | null;
};
const fieldDraft = (input: FieldInput): FieldDraft => ({
  key: input.key,
  kind: KIND_OF[input.kind],
  label: {
    fr: input.label?.fr ?? undefined,
    en: input.label?.en ?? undefined,
  },
  required: input.required ?? undefined,
  min: input.min ?? undefined,
  max: input.max ?? undefined,
  maxLength: input.maxLength ?? undefined,
  values: input.values?.map(valueDraft),
});

const resourceShape = (
  resource: StoredResourceDoc,
  scopes: StoredScopeDoc[],
  types: StoredDetailTypeDoc[],
  document: ProtectedResourceDocument | null,
) => ({
  id: resource._id.toHexString(),
  uri: resource.uri,
  name: resource.name,
  scopes: scopes
    .filter((scope) => scope.resourceId?.equals(resource._id))
    .map(scopeShape),
  detailTypes: types
    .filter((doc) => doc.resourceId.equals(resource._id))
    .map(detailTypeShape),
  metadataUrl: document?.metadataUrl ?? null,
  protectedResourceMetadata: document?.metadata ?? null,
  allowClientCredentials: resource.allowClientCredentials === true,
  createdAt: resource.createdAt,
});

type ProtectedResourceDocument = Awaited<
  ReturnType<typeof protectedResourceDocument>
>;

// The RFC 9728 documents of a tenant's resources: the tenant's issuer (its
// primary host when it has one) and DPoP policy come from the resolved
// tenant, read once per request however many resources it shows. A host that
// does not resolve gives `null` documents, never an error.
const documentsOf = (slug: string) => {
  let tenant: ReturnType<typeof tenantResolver.resolveHost> | undefined;
  return async (resource: StoredResourceDoc, scopes: StoredScopeDoc[]) => {
    tenant ??= tenantResolver.resolveHost(hostOf(slug, env.CLAVIX_DOMAIN));
    const resolved = await tenant;
    if (resolved === null) return null;
    return protectedResourceDocument({
      uri: resource.uri,
      issuer: resolved.issuer,
      scopes: scopes
        .filter((scope) => scope.resourceId?.equals(resource._id))
        .map((scope) => scope.name),
      dpopRequired: resolved.oauth.dpop.required,
    });
  };
};

export const resources: Resolvers = {
  Query: {
    resources: async (_, { tenantId }, ctx) => {
      const { _id, slug } = await catalogTenant(ctx, tenantId);
      const [found, scopes, types] = await Promise.all([
        resourcesService.listResources(_id),
        resourcesService.listScopes(_id),
        resourcesService.listDetailTypes(_id),
      ]);
      const documentOf = documentsOf(slug);
      return Promise.all(
        found.map(async (resource) =>
          resourceShape(
            resource,
            scopes,
            types,
            await documentOf(resource, scopes),
          ),
        ),
      );
    },
    resource: async (_, { tenantId, id }, ctx) => {
      const { _id, slug } = await catalogTenant(ctx, tenantId);
      const found = await resourcesService.findResource(_id, id);
      if (found === undefined) return null;
      const scopes = await resourcesService.listScopes(_id, {
        resourceId: found._id,
      });
      return resourceShape(
        found,
        scopes,
        await resourcesService.listDetailTypes(_id, { resourceId: found._id }),
        await documentsOf(slug)(found, scopes),
      );
    },
    scopes: async (_, { tenantId, resourceId }, ctx) => {
      const { _id } = await catalogTenant(ctx, tenantId);
      if (resourceId === undefined || resourceId === null) {
        return (await resourcesService.listScopes(_id)).map(scopeShape);
      }
      const owner = await resourcesService.findResource(_id, resourceId);
      return owner === undefined
        ? []
        : (
            await resourcesService.listScopes(_id, { resourceId: owner._id })
          ).map(scopeShape);
    },
  },
  Mutation: {
    createResource: async (_, { tenantId, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const created = await refusing(() =>
        resourcesService.createResource(tenant._id, tenant.slug, {
          uri: input.uri,
          name: input.name ?? undefined,
        }),
      );
      await ctx.audit(
        "resource.create",
        target("resource", tenant._id, created._id),
      );
      return resourceShape(
        created,
        [],
        [],
        await documentsOf(tenant.slug)(created, []),
      );
    },
    updateResource: async (_, { tenantId, id, input }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const { _id, slug } = tenant;
      const updated = await refusing(async () => {
        refuseMachineConsole(
          tenant,
          await resourcesService.findResource(_id, id),
          input.allowClientCredentials,
        );
        return resourcesService.updateResource(_id, id, {
          name: input.name ?? undefined,
          allowClientCredentials: input.allowClientCredentials ?? undefined,
        });
      });
      await ctx.audit("resource.update", target("resource", _id, updated._id));
      const scopes = await resourcesService.listScopes(_id, {
        resourceId: updated._id,
      });
      return resourceShape(
        updated,
        scopes,
        await resourcesService.listDetailTypes(_id, {
          resourceId: updated._id,
        }),
        await documentsOf(slug)(updated, scopes),
      );
    },
    deleteResource: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      let scopes: StoredScopeDoc[] = [];
      let types: StoredDetailTypeDoc[] = [];
      const removed = await refusing(async () => {
        const found = await resourcesService.findResource(tenant._id, id);
        keepConsoleResource(tenant, found);
        if (found !== undefined) {
          scopes = await resourcesService.listScopes(tenant._id, {
            resourceId: found._id,
          });
          types = await resourcesService.listDetailTypes(tenant._id, {
            resourceId: found._id,
          });
          // The roles scoped to it go first: were the resource gone before them
          // a retry would find nothing to clean up.
          const roles = await rolesService.deleteForResource(
            tenant._id,
            found._id,
          );
          // The exchange rules that target it go before it too, for the same reason.
          await clientPoliciesService.removeTarget(tenant._id, found.uri);
          // Recorded now: were the resource delete to fail, a retry finds no
          // role left and could not record them.
          for (const role of roles) {
            await ctx.audit("role.delete", {
              type: "role",
              id: role._id.toHexString(),
              tenantId: tenant._id.toHexString(),
            });
          }
        }
        return resourcesService.deleteResource(tenant._id, id);
      });
      // Its scopes go with it: one event each, then the resource's, which is
      // recorded on a repeat too (it may be the event the first run missed).
      for (const scope of scopes) {
        await ctx.audit("scope.delete", target("scope", tenant._id, scope._id));
      }
      for (const type of types) {
        await ctx.audit(
          "detailType.delete",
          target("detailType", tenant._id, type._id),
        );
      }
      if (ObjectId.isValid(id)) {
        await ctx.audit(
          "resource.delete",
          target("resource", tenant._id, new ObjectId(id)),
        );
      }
      return removed;
    },
    createScope: async (_, { tenantId, input }, ctx) => {
      const { _id } = await catalogTenant(ctx, tenantId);
      const created = await refusing(() =>
        resourcesService.createScope(_id, {
          name: input.name,
          description: {
            fr: input.description?.fr ?? undefined,
            en: input.description?.en ?? undefined,
          },
          resourceId: input.resourceId ?? null,
          claims: input.claims ?? undefined,
        }),
      );
      await ctx.audit("scope.create", target("scope", _id, created._id));
      return scopeShape(created);
    },
    updateScope: async (_, { tenantId, id, input }, ctx) => {
      const { _id } = await catalogTenant(ctx, tenantId);
      const updated = await refusing(() =>
        resourcesService.updateScope(_id, id, {
          description:
            input.description === undefined || input.description === null
              ? undefined
              : {
                  fr: input.description.fr ?? undefined,
                  en: input.description.en ?? undefined,
                },
          claims: input.claims ?? undefined,
        }),
      );
      await ctx.audit("scope.update", target("scope", _id, updated._id));
      return scopeShape(updated);
    },
    deleteScope: async (_, { tenantId, id }, ctx) => {
      const tenant = await catalogTenant(ctx, tenantId);
      const removed = await refusing(async () => {
        const scope = await resourcesService.findScope(tenant._id, id);
        if (scope !== undefined && scope.resourceId !== null) {
          keepConsoleResource(
            tenant,
            await resourcesService.findResource(
              tenant._id,
              scope.resourceId.toHexString(),
            ),
          );
        }
        return resourcesService.deleteScope(tenant._id, id);
      });
      if (ObjectId.isValid(id)) {
        await ctx.audit(
          "scope.delete",
          target("scope", tenant._id, new ObjectId(id)),
        );
      }
      return removed;
    },
    createDetailType: async (_, { tenantId, input }, ctx) => {
      const { _id } = await catalogTenant(ctx, tenantId);
      const created = await refusing(() =>
        resourcesService.createDetailType(_id, input.resourceId, {
          type: input.type,
          name: {
            fr: input.name.fr ?? undefined,
            en: input.name.en ?? undefined,
          },
          description: {
            fr: input.description?.fr ?? undefined,
            en: input.description?.en ?? undefined,
          },
          fields: input.fields.map(fieldDraft),
          actions: input.actions?.map(valueDraft),
        }),
      );
      await ctx.audit(
        "detailType.create",
        target("detailType", _id, created._id),
      );
      return detailTypeShape(created);
    },
    updateDetailType: async (_, { tenantId, id, input }, ctx) => {
      const { _id } = await catalogTenant(ctx, tenantId);
      const updated = await refusing(() =>
        resourcesService.updateDetailType(_id, id, {
          name:
            input.name === undefined || input.name === null
              ? undefined
              : {
                  fr: input.name.fr ?? undefined,
                  en: input.name.en ?? undefined,
                },
          description:
            input.description === undefined || input.description === null
              ? undefined
              : {
                  fr: input.description.fr ?? undefined,
                  en: input.description.en ?? undefined,
                },
          fields: input.fields?.map(fieldDraft),
          actions: input.actions?.map(valueDraft),
        }),
      );
      await ctx.audit(
        "detailType.update",
        target("detailType", _id, updated._id),
      );
      return detailTypeShape(updated);
    },
    deleteDetailType: async (_, { tenantId, id }, ctx) => {
      const { _id } = await catalogTenant(ctx, tenantId);
      const removed = await refusing(() =>
        resourcesService.deleteDetailType(_id, id),
      );
      if (ObjectId.isValid(id)) {
        await ctx.audit(
          "detailType.delete",
          target("detailType", _id, new ObjectId(id)),
        );
      }
      return removed;
    },
  },
};
