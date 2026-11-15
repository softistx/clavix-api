import type { ConsoleUsers } from "../../context";
import { poolOf, type UsersSource } from "./pool";
import { poolGrants } from "./pool-grants";
import { poolInvitations } from "./pool-invitations";
import { poolSessions } from "./pool-sessions";
import { poolUsers } from "./pool-users";

export type { UsersSource } from "./pool";

/** `ConsoleUsers` over each tenant's janus instance and OAuth server. */
export function createJanusUsers(source: UsersSource): ConsoleUsers {
  const pool = poolOf(source);
  return {
    ...poolUsers(pool),
    ...poolSessions(pool),
    ...poolInvitations(pool),
    ...poolGrants(pool),
  };
}
