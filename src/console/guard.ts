import { MapperKind, mapSchema } from "@graphql-tools/utils";
import { denial } from "@softistx/janus-graphql";
import type { GraphQLSchema } from "graphql";
import { ObjectId } from "mongodb";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import type { ConsoleContext } from "./context";
import type { Permission } from "./model";

/**
 * What a root field requires. Every root field of the console API must have
 * one (`Query.me`, `Mutation.createTenant`...): a field with none is denied.
 */
export type Guard =
  | { kind: "signedIn" }
  | {
      kind: "tenant";
      permission: Permission;
      /** The tenant the call touches, from the field's arguments. */
      tenant: (args: Record<string, unknown>) => string;
    }
  | { kind: "platform"; permission: Permission };

/** Any caller with a valid console token (a field about the caller itself). */
export const signedIn = (): Guard => ({ kind: "signedIn" });

/** `permission` on the tenant `tenant(args)` names (`ctx.can`). */
export const onTenant = (
  permission: Permission,
  tenant: (args: Record<string, unknown>) => string,
): Guard => ({ kind: "tenant", permission, tenant });

/** `permission` on the platform (`ctx.canPlatform`). */
export const onPlatform = (permission: Permission): Guard => ({
  kind: "platform",
  permission,
});

/** The guards by root field, keyed `Query.me`. */
export type Guards = Readonly<Record<string, Guard>>;

/** Whether `tenantId` is the `clavix` tenant itself (an unknown or malformed id is not). */
async function isPlatformTenant(ctx: ConsoleContext, tenantId: string) {
  if (!ObjectId.isValid(tenantId)) return false;
  const [found] = await ctx.directory.tenantsByIds([tenantId]);
  return found?.slug === PLATFORM_TENANT_SLUG;
}

async function allowed(
  guard: Guard,
  args: Record<string, unknown>,
  ctx: ConsoleContext,
) {
  switch (guard.kind) {
    case "signedIn":
      return true;
    case "tenant": {
      const tenantId = guard.tenant(args);
      // A write on Clavix's own tenant is the platform's: a tenant-level role
      // there (an operator's) must not reach the operators, the issuer's
      // domains, its sign-in policy or its clients.
      if (
        guard.permission !== "view" &&
        (await isPlatformTenant(ctx, tenantId))
      ) {
        return ctx.canPlatform(guard.permission);
      }
      return ctx.can(guard.permission, tenantId);
    }
    case "platform":
      return ctx.canPlatform(guard.permission);
  }
}

const deny = () => denial("FORBIDDEN", "Not allowed");

/**
 * Wraps every root field (query, mutation, subscription) of the schema so its
 * guard runs first. **Deny by default**: a field with no entry in `guards` is
 * refused, whoever calls it, so a new field is never open by omission.
 */
export function guardSchema(
  schema: GraphQLSchema,
  guards: Guards,
): GraphQLSchema {
  return mapSchema(schema, {
    [MapperKind.ROOT_FIELD]: (config, fieldName, typeName) => {
      const guard = guards[`${typeName}.${fieldName}`];
      const resolve = config.resolve;
      const check = async (
        args: Record<string, unknown>,
        ctx: ConsoleContext,
      ) => {
        if (guard === undefined || !(await allowed(guard, args, ctx))) {
          throw deny();
        }
      };
      return {
        ...config,
        resolve: async (source, args, ctx, info) => {
          await check(args, ctx as ConsoleContext);
          return resolve === undefined
            ? source?.[fieldName]
            : resolve(source, args, ctx, info);
        },
        // No subscription is offered; one would be denied here too.
        ...(typeName === "Subscription"
          ? {
              subscribe: async () => {
                throw deny();
              },
            }
          : {}),
      };
    },
  });
}
