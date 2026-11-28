import { oauthDb } from "@/config/oauth-db";

/** A client row as janus's OAuth store keeps it, with the string `_id` it uses. */
export interface ClientRow {
  _id: string;
  name: string;
  redirectUris: string[];
  source: string;
  createdAt: Date;
  expiresAt: Date | null;
  partition: string;
  allowedScopes?: string[];
  defaultScopes?: string[];
}

/** The partitioned clients collection, typed with its string ids. */
export const clientRows = () =>
  oauthDb.collection<ClientRow>("oauthPartitionedClients");

/** A registered client of `partition` (a tenant's hex id), listing scopes as `lists` says. */
export const clientRow = (
  id: string,
  partition: string,
  lists: Pick<ClientRow, "allowedScopes" | "defaultScopes"> = {},
): ClientRow => ({
  _id: id,
  name: id,
  redirectUris: ["https://app.example/cb"],
  source: "registered",
  createdAt: new Date(),
  expiresAt: null,
  partition,
  ...lists,
});
