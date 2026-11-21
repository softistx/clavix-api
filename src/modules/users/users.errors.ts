import { fail } from "@/shared/errors";

// A tenant suspended or deleted since the resolver checked it: not found, as
// for any other call that names it.
export const gone = () => fail("NOT_FOUND", "No such tenant", { status: 404 });
