import { createClientIndex } from "@/modules/clients/client-index";
import { ClientsService } from "@/modules/clients/clients.service";
import { mongo } from "./db";
import { oauthDb } from "./oauth-db";

// Temporary, until @softistx/janus-oauth#706
/**
 * The console's list of clients, and what the `clients:create` script tells
 * so its clients are listed too. Goes when janus-oauth's `listClients` is
 * released: `ClientsService.list` then reads the janus store.
 */
export const clientIndex = createClientIndex(mongo.db.clientIndex);

/** A tenant's OAuth clients, for the console. */
export const clientsService = new ClientsService({
  db: oauthDb,
  index: clientIndex,
});
