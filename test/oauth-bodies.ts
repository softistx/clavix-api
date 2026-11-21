import { z } from "zod";

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

/** What a token endpoint may answer, success or refusal, every field optional. */
export const answerBody = z.looseObject({
  access_token: z.string().optional(),
  refresh_token: z.string().nullish(),
  id_token: z.string().nullish(),
  issued_token_type: z.string().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
