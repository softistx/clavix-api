import { denial } from "@softistx/janus-graphql";

// A tenant suspended or deleted since the resolver checked it: not found, as
// for any other call that names it.
export const gone = () => denial("NOT_FOUND", "No such tenant");
