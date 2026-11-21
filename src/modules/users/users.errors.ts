import { fail } from "@/shared/errors";

// A tenant suspended or deleted since the resolver checked it: not found, as
// for any other call that names it.
export const gone = () => fail("NOT_FOUND", "No such tenant", { status: 404 });

/** Ownership granted between the read of the tenants and their locks. */
export class OwnershipMoved extends Error {
  constructor(readonly tenants: readonly string[]) {
    super("ownership moved");
  }
}
