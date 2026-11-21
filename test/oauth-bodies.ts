import { z } from "zod";
import { tokenBody } from "~/json";

/** An OAuth JSON answer a spec reads by name only: any object. */
export const recordBody = z.record(z.string(), z.unknown());

/** The answer of the device authorization endpoint (RFC 8628). */
export const deviceCodesBody = z.looseObject({
  device_code: z.string(),
  user_code: z.string(),
});

/** The answer of the pushed authorization request endpoint (RFC 9126). */
export const parBody = z.looseObject({ request_uri: z.string() });

/** A token answer read for its ID token alone. */
export const idTokenBody = z.looseObject({ id_token: z.string() });

/** What a token endpoint may answer, success or refusal: the token body with every field optional, plus the refusal's. */
export const answerBody = tokenBody.partial().extend({
  id_token: z.string().nullish(),
  issued_token_type: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
