import type { Permission } from "@/console/model";
import type { GraphqlRules } from "@/generated/limix";
import type { PlatformConditionName } from "./conditions";

type Rule = NonNullable<GraphqlRules<PlatformConditionName>["Query.me"]>;

const platformCondition = {
  view: "platformView",
  edit: "platformEdit",
  manage: "platformManage",
} as const satisfies Record<Permission, PlatformConditionName>;

/** Any caller with an accepted console token (the guard also asks for a proved e-mail). */
export const signedIn: Rule = { authenticated: true };

/**
 * `permission` on the tenant the field's `argument` names: a relation of the
 * console's ReBAC model on the tenant object. A refusal is a 403, as the
 * console's guard answers it (not the 404 limix hides an object with).
 */
export const onTenant = (
  permission: Permission,
  argument: "tenantId" | "id",
): Rule => ({
  authenticated: true,
  relations: [
    {
      require: [
        [{ relation: permission, type: "tenant", from: `args.${argument}` }],
      ],
      onDeny: "FORBIDDEN",
    },
  ],
});

/** `permission` on the platform (Clavix's operators). */
export const onPlatform = (permission: Permission): Rule => ({
  authenticated: true,
  when: [platformCondition[permission]],
});
