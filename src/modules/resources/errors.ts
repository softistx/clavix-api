import type { ObjectId } from "mongodb";

/** What the script needs of a stored tenant. */
export interface ClientTenant {
  _id: ObjectId;
  slug: string;
  status: "active" | "suspended";
}

/** The script's input is wrong: the message says how. */
export class ClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientInputError";
  }
}

/** The slug names no tenant. */
export class UnknownTenantError extends ClientInputError {
  constructor(slug: string) {
    super(`no tenant has the slug "${slug}"`);
    this.name = "UnknownTenantError";
  }
}

/** The tenant is suspended: no client is registered on it. */
export class SuspendedTenantError extends ClientInputError {
  constructor(slug: string) {
    super(`tenant "${slug}" is suspended; reactivate it first`);
    this.name = "SuspendedTenantError";
  }
}
