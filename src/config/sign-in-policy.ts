import { SignInPolicyService } from "@/modules/sign-in-methods";
import { secretBox } from "./keys";
import { warn } from "./runtime";
import { tenantSocialService, tenantsService } from "./tenancy";

/** The sign-in policy service on the app's tenants service and secret box. */
export const signInPolicyService = new SignInPolicyService(
  tenantsService,
  tenantSocialService,
  secretBox,
  warn,
);
