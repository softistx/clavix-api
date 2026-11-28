import type { Permission } from "@/console/model";
import type { GraphqlRules } from "@/generated/limix";
import type { PlatformConditionName } from "./conditions";
import { signedIn } from "./rules.helpers";

type Rule = NonNullable<GraphqlRules<PlatformConditionName>["Query.me"]>;

export const platformCondition = {
  view: "platformView",
  edit: "platformEdit",
  manage: "platformManage",
} as const satisfies Record<Permission, PlatformConditionName>;

/** The scope every console token carries (`useConsole` accepts no other): a permission of the claims' `scope`. */
export const CONSOLE_SCOPE = "console";

/** Any caller with an accepted console token (the guard also asks for a proved e-mail). */
export const consoleSignedIn: Rule = {
  ...signedIn,
  permissions: [[CONSOLE_SCOPE]],
};

/**
 * `permission` on the tenant the field's `argument` names: a relation of the
 * console's ReBAC model on the tenant object. A refusal is a 403, as the
 * console's guard answers it (not the 404 limix hides an object with).
 */
export const onTenant = (
  permission: Permission,
  argument: "tenantId" | "id",
): Rule => ({
  ...consoleSignedIn,
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
  ...consoleSignedIn,
  when: [platformCondition[permission]],
});
