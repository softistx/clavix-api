import { mongo } from "@/config/db";

// A deployment step: brings every collection's validator and indexes to what
// its definition says and prints what changed. It needs the dbAdmin role,
// which the app itself should not hold.
try {
  console.log(JSON.stringify(await mongo.sync(), null, 2));
} finally {
  await mongo.close();
}
