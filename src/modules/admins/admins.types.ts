import type { Access } from "@/console/access";
import type { Exclusive } from "@/console/exclusive";
import type { Role } from "@/console/model";

/** What the memberships read and write of the relation store. */
export type AdminsAccess = Pick<
  Access,
  "holders" | "platformHolders" | "grantTenant" | "revokeTenant"
>;

/** A user of the `clavix` tenant as the directory finds them. */
export interface DirectoryUser {
  id: string;
  email: string;
  name?: string | undefined;
  /** Whether the user can sign in (a disabled one cannot). */
  active: boolean;
}

/** What the memberships read of the users: `ConsoleDirectory` satisfies it (not imported: it would close a cycle with the console context). */
export interface AdminsDirectory {
  findUser(id: string): Promise<DirectoryUser | null>;
}

export interface AdminsServiceOptions {
  access: AdminsAccess;
  directory: AdminsDirectory;
  exclusive: Exclusive;
}

/** A user of the `clavix` tenant with the role they hold directly. */
export interface Member {
  user: DirectoryUser;
  role: Role;
}
