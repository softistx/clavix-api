// Runs once, on the first start of an empty data volume (the image's initdb,
// through mongosh): creates the application user in the clavix database, with
// readWrite (the api) and dbAdmin (db:sync applies validators and indexes). The
// credentials come from the environment, never from a file.
const user = process.env.MONGO_APP_USER;
const pwd = process.env.MONGO_APP_PASSWORD;
if (!user || !pwd)
  throw new Error("MONGO_APP_USER and MONGO_APP_PASSWORD are required");
db.getSiblingDB("clavix").createUser({
  user,
  pwd,
  roles: [
    { role: "readWrite", db: "clavix" },
    { role: "dbAdmin", db: "clavix" },
  ],
});
