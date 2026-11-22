import { ProfilePoliciesService } from "@/modules/profile";
import { mongo } from "./db";

/** The real profile locks. The collection is tenant-owned: only this wiring and the module reach it. */
export const profilePoliciesService = new ProfilePoliciesService({
  policies: mongo.db.profilePolicies,
});
