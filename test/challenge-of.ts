import { z } from "zod";

const optionsBody = z.looseObject({ challenge: z.unknown() });

/** The challenge inside the options JSON of a passkey ceremony (a body without one fails the spec). */
export const challengeOfOptions = (options: string): string =>
  String(optionsBody.parse(JSON.parse(options)).challenge);

/** What a passkey ceremony answers: the options JSON for the browser and the challenge to keep. */
export const ceremonyAnswer = z.looseObject({
  options: z.string(),
  challenge: z.string(),
});
