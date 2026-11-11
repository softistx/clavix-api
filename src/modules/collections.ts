import { defineCollection, id } from "@softistx/mongo";
import { z } from "zod";

// Every collection of the app, under the key the Mongo exposes it by
// (`mongo.db.tenants`): src/config/db.ts wires this module object. A module
// adds its models here.
//
// Temporary placeholder: `defineMongo` refuses a module with no definition in
// it, so step 1 of slice 1.1 wires this minimal `tenants`. Step 2 replaces it
// with src/modules/tenants' real model.
export const tenants = defineCollection({
  name: "tenants",
  schema: z.object({ _id: id(), slug: z.string(), name: z.string() }),
});
