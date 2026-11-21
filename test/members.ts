import { createConsoleDeps } from "@/config/console";
import { noBudgets } from "@/config/no-ops";
import type { Access } from "@/console/access";
import type {
  ConsoleContext,
  ConsoleDirectory,
  ConsoleUsers,
} from "@/console/context";
import type { Exclusive } from "@/console/exclusive";
import type { ConsoleDeps } from "@/console/plugin";
import { AdminsService } from "@/modules/admins";

/** What a spec fakes of a console context: each part is the real one, but for the members it gives. */
export interface FakeConsole {
  exclusive: Exclusive;
  canPlatform?: ConsoleContext["canPlatform"];
  can?: ConsoleContext["can"];
  audit?: ConsoleContext["audit"];
  access?: Partial<Access>;
  directory?: Partial<ConsoleDirectory>;
  users?: Partial<ConsoleUsers>;
}

const deps: ConsoleDeps = createConsoleDeps({ serverFor: async () => null });

/**
 * A console context for a spec that calls a resolver or a rule directly: the
 * real wiring of `createConsoleDeps`, with the parts the spec fakes laid over
 * it, and the memberships service built on the faked access, directory and lock.
 */
export function withMembers(fake: FakeConsole): ConsoleContext {
  const access: Access = { ...deps.access, ...fake.access };
  const directory: ConsoleDirectory = { ...deps.directory, ...fake.directory };
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/console/graphql"),
    principal: {
      userId: "spec",
      clientId: "spec",
      grantId: "spec",
      scopes: ["console"],
      clientName: null,
      bound: null,
      jkt: null,
      authorizationDetails: [],
    },
    can: fake.can ?? (async () => true),
    canPlatform: fake.canPlatform ?? (async () => true),
    audit: fake.audit ?? (async () => {}),
    access,
    directory,
    admins: deps.admins,
    members: new AdminsService({
      access,
      directory,
      exclusive: fake.exclusive,
    }),
    users: { ...deps.users, ...fake.users },
    exclusive: fake.exclusive,
    budgets: noBudgets,
    activity: deps.activity,
  };
}
