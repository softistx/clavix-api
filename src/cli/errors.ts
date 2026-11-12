import type { ObjectId } from "mongodb";

/** What a script needs of a stored tenant. */
export interface CliTenant {
  _id: ObjectId;
  slug: string;
  status: "active" | "suspended";
}

/** A script's input is wrong: the message says how. */
export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

/** The slug names no tenant. */
export class UnknownTenantError extends CliInputError {
  constructor(slug: string) {
    super(`no tenant has the slug "${slug}"`);
    this.name = "UnknownTenantError";
  }
}

/** The tenant is suspended: no client is registered on it. */
export class SuspendedTenantError extends CliInputError {
  constructor(slug: string) {
    super(`tenant "${slug}" is suspended; reactivate it first`);
    this.name = "SuspendedTenantError";
  }
}
