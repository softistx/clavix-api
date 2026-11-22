import {
  syncMongoInvitationsPartitioned,
  syncMongoRelations,
  syncMongoStoresPartitioned,
} from "@softistx/janus-mongo";
import { syncMongoOAuthPartitioned } from "@softistx/janus-oauth-mongo";
import { closeMongo, connectMongo, mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";

// A deployment step: brings every collection's validator and indexes to what
// its definition says and prints what changed. It needs the dbAdmin role,
// which the app itself should not hold. The janus OAuth collections and the
// janus user stores (one partition per tenant) are synced beside the app's own.
try {
  await connectMongo();
  console.log(
    JSON.stringify(
      {
        app: await mongo.sync(),
        oauth: await syncMongoOAuthPartitioned(oauthDb),
        users: await syncMongoStoresPartitioned(oauthDb),
        invitations: await syncMongoInvitationsPartitioned(oauthDb),
        relations: await syncMongoRelations(oauthDb),
      },
      null,
      2,
    ),
  );
} finally {
  await closeMongo();
}
