import { denial, janusMaskError, useJanus } from "@softistx/janus-graphql";
import { janusIssuers } from "@/config/users";
import type { SignInThrottle } from "./throttle";

// `ctx.janus` on every operation, from the janus instance of the tenant the
// request's host names (a session of another tenant is anonymous there), and
// the renewed session cookie sent back. A host that names no active tenant is
// a NOT_FOUND on the fields that ask who the caller is.
export const janusPlugin = () =>
  useJanus({
    auth: async (ctx) => {
      const auth =
        ctx.request === undefined
          ? null
          : await janusIssuers.forRequest(ctx.request);
      if (auth === null) throw denial("NOT_FOUND", "No such tenant");
      return auth;
    },
  });

// A JanusError a resolver lets through is answered with its code and status
// (MAIL_THROTTLED 429, STORE_FAILED 503), the rest as Yoga masks it.
export const janusMasking = { maskError: janusMaskError() };

// The throttle `requestSignInCode` consults, put on every context by
// `createApp({ signInThrottle })`; none: no extra limit.
const THROTTLE = "signInThrottle" as const;
type WithThrottle = { [THROTTLE]?: SignInThrottle | undefined };

export const throttleContext = (throttle: SignInThrottle | undefined) => ({
  onContextBuilding: ({
    extendContext,
  }: {
    extendContext: (extension: WithThrottle) => void;
  }) => extendContext({ [THROTTLE]: throttle }),
});

export const throttleOf = (ctx: unknown): SignInThrottle | undefined =>
  (ctx as WithThrottle)[THROTTLE];
