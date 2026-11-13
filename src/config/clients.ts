import { ClientsService } from "@/modules/clients/clients.service";
import { oauthDb } from "./oauth-db";

/** A tenant's OAuth clients, for the console. */
export const clientsService = new ClientsService({ db: oauthDb });
