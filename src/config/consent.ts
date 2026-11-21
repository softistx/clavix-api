import { ConsentService } from "@/modules/consent/consent.service";
import { clock, warn } from "./runtime";

/** The consent API's service: stateless over the request context, built once. */
export const consentService = new ConsentService({ log: warn, now: clock });
