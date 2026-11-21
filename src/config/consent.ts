import { ConsentService } from "@/modules/consent/consent.service";

/** The consent API's service: stateless over the request context, built once. */
export const consentService = new ConsentService();
