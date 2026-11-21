import { denial } from "@softistx/janus-graphql";
import { fail } from "@/shared/errors";

// A tenant suspended or deleted since the resolver checked it: not found, as
// for any other call that names it.
export const gone = () => denial("NOT_FOUND", "No such tenant");

export const badInput = (message: string) =>
  fail("BAD_USER_INPUT", message, { status: 400 });
