import { storedResourcesFor } from "@/modules/resources/register-resource";
import { mongo } from "./db";

/** The real `ResourcesFor`: the tenants' stored resources (`resources:create`). */
export const resourcesFor = storedResourcesFor(mongo.db.resources);

/** The `resources` collection, for the `resources:create` script. */
export const resourcesCollection = mongo.db.resources;
