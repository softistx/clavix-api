import type { OAuthPrincipal } from "@softistx/janus-oauth";
import type { YogaInitialContext } from "graphql-yoga";
import type { Access } from "./access";
import type { Permission } from "./model";
import type { ConsoleAdmins } from "./modules/admins/ports";

/** What the console needs to look a user or tenants up, injected (see `src/config/console.ts`). */
export interface ConsoleDirectory {
  /** A user of the `clavix` tenant, or `null` (gone, deactivated). */
  findUser(
    id: string,
  ): Promise<{ id: string; email: string; name?: string | undefined } | null>;
  /** The active tenants with these ids (hex), in any order; unknown ids are left out. */
  tenantsByIds(
    ids: readonly string[],
  ): Promise<{ id: string; slug: string; name: string }[]>;
}

/** What the console's plugin puts on every context, for a request whose bearer token was accepted. */
export interface ConsoleExtras {
  /** Who the token belongs to (the user, the client, its scopes). */
  readonly principal: OAuthPrincipal;
  /** Whether the caller has `permission` on the tenant; a denial is `false`. */
  can(permission: Permission, tenantId: string): Promise<boolean>;
  /** Whether the caller has `permission` on the platform itself. */
  canPlatform(permission: Permission): Promise<boolean>;
  readonly access: Access;
  readonly directory: ConsoleDirectory;
  readonly admins: ConsoleAdmins;
}

/** A console resolver's context. The generated `Resolvers` takes it (codegen.console.ts). */
export type ConsoleContext = YogaInitialContext & ConsoleExtras;
