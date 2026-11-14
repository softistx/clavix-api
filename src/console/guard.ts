import { MapperKind, mapSchema } from "@graphql-tools/utils";
import { denial } from "@softistx/janus-graphql";
import { GraphQLError, type GraphQLSchema } from "graphql";
import { ObjectId } from "mongodb";
import { PLATFORM_TENANT_SLUG } from "@/modules/tenants/slug";
import { requireVerifiedEmail } from "@/users/verified-email";
import type { ConsoleContext } from "./context";
import type { Permission } from "./model";

/**
 * What a root field requires. Every root field of the console API must have
 * one (`Query.me`, `Mutation.createTenant`...): a field with none is denied.
 */
export type Guard =
  | { kind: "signedIn"; unverifiedOk?: true }
  | {
      kind: "tenant";
      permission: Permission;
      /** The tenant the call touches, from the field's arguments. */
      tenant: (args: Record<string, unknown>) => string;
    }
  | { kind: "platform"; permission: Permission };

/**
 * Any caller with a valid console token **and a proved e-mail** (ADR-0041),
 * like every other guard: the catalogue of plans, for one.
 */
export const signedIn = (): Guard => ({ kind: "signedIn" });

/**
 * Any caller with a valid console token, **proved e-mail or not**: only `me`,
 * so the UI can tell the caller why the rest is refused (EMAIL_UNVERIFIED).
 */
export const aboutCaller = (): Guard => ({
  kind: "signedIn",
  unverifiedOk: true,
});

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

/** The tenant a call names, or `undefined` (unknown, malformed or trashed id). */
async function targetOf(ctx: ConsoleContext, tenantId: string) {
  if (!ObjectId.isValid(tenantId)) return undefined;
  const [found] = await ctx.directory.tenantsByIds([tenantId]);
  return found;
}

/**
 * A write refused because its tenant is suspended (ADR-0039): the console
 * stays readable, nothing in it changes until the platform resumes the tenant.
 */
const suspended = () =>
  new GraphQLError("The tenant is suspended", {
    extensions: { code: "TENANT_SUSPENDED", http: { status: 403 } },
  });

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
      if (guard.permission === "view") return ctx.can("view", tenantId);
      const target = await targetOf(ctx, tenantId);
      // A write on Clavix's own tenant is the platform's: a tenant-level role
      // there (an operator's) must not reach the operators, the issuer's
      // domains, its sign-in policy or its clients.
      if (target?.slug === PLATFORM_TENANT_SLUG) {
        return ctx.canPlatform(guard.permission);
      }
      if (!(await ctx.can(guard.permission, tenantId))) return false;
      // Allowed by role, refused by state: only a platform operator still
      // writes on a suspended tenant (support). The role check comes first so
      // a caller with no right learns nothing of the tenant's state.
      if (
        target?.status === "suspended" &&
        !(await ctx.canPlatform(guard.permission))
      ) {
        throw suspended();
      }
      return true;
    }
    case "platform":
      return ctx.canPlatform(guard.permission);
  }
}

/** The caller's e-mail must be proved: `EMAIL_UNVERIFIED` (403) otherwise. */
async function verifiedCaller(ctx: ConsoleContext) {
  requireVerifiedEmail({
    emailVerified: await ctx.directory.emailVerified(ctx.principal.userId),
  });
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
        if (guard === undefined) throw deny();
        // Every field but `me` (`aboutCaller`, so the UI can explain) needs
        // the caller's e-mail proved (ADR-0041). Before the role check:
        // an unproved caller can do nothing, whatever their roles. Platform
        // operators are held to it too; ADR-0039's exception is about the
        // target tenant's state, not the caller's.
        if (guard.kind !== "signedIn" || guard.unverifiedOk !== true) {
          await verifiedCaller(ctx);
        }
        if (!(await allowed(guard, args, ctx))) throw deny();
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
