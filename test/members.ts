import type { ConsoleContext } from "@/console/context";
import { AdminsService } from "@/modules/admins";

/** A fake console context (its access, directory and exclusive) with the memberships service over them. */
export const withMembers = (fake: {
  access: unknown;
  directory: unknown;
  exclusive: unknown;
  [key: string]: unknown;
}) =>
  ({
    ...fake,
    members: new AdminsService(fake as never),
  }) as unknown as ConsoleContext;
