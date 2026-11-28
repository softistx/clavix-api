import type { Condition, ConditionMap } from "@softistx/limix";
import type { Permission } from "@/console/model";

/** Whether the caller holds `permission` on the platform itself (`ctx.canPlatform`). */
export type PlatformCheck = (permission: Permission) => Promise<boolean>;

const isPlatformCheck = (value: unknown): value is PlatformCheck =>
  typeof value === "function";

/**
 * The platform has one object (`PLATFORM`, `clavix`), so a rule cannot name it
 * in a relation term (`from` reads an argument, there is no constant): it is a
 * condition asking the claims' `platform` check instead. One name per
 * permission.
 */
const platformHolds =
  (permission: Permission): Condition =>
  ({ claims }) => {
    const check = claims["platform"];
    return isPlatformCheck(check) ? check(permission) : false;
  };

export const conditions = {
  platformView: platformHolds("view"),
  platformEdit: platformHolds("edit"),
  platformManage: platformHolds("manage"),
} satisfies ConditionMap;
export type PlatformConditionName = keyof typeof conditions;
