import { denial } from "@softistx/janus-graphql";
import {
  guardGraxiaSchema,
  janusGraxia,
  janusGraxiaMaskError,
} from "@softistx/janus-graphql/graxia";
import { createLogger } from "@softistx/telemetry";
import { janusIssuers } from "@/config/users";

import { scrubbed } from "@/http/unexpected";

const log = createLogger("janus");

// `ctx.janus` on every operation, from the janus instance of the tenant the
// request's host names (a session of another tenant is anonymous there), and
// the renewed session cookie sent back. A host that names no active tenant is
// a NOT_FOUND on the fields that ask who the caller is.
const options = {
  auth: async (ctx: { request?: Request }) => {
    const auth =
      ctx.request === undefined
        ? null
        : await janusIssuers.forRequest(ctx.request);
    if (auth === null) throw denial("NOT_FOUND", "No such tenant");
    return auth;
  },
};

export const janusPlugin = () => janusGraxia(options);

/** The schema with janus's directives applied: graxia cannot replace it from a plugin. */
export const guardedSchema = (
  schema: Parameters<typeof guardGraxiaSchema>[0],
) => guardGraxiaSchema(schema, options);

// A JanusError a resolver lets through is answered with its code and status
// (MAIL_THROTTLED 429, STORE_FAILED 503), the rest as graxia masks it.
export const janusMasking = {
  maskError: janusGraxiaMaskError({
    report: (error) => log.error("janus error answered 5xx", scrubbed(error)),
  }),
};
