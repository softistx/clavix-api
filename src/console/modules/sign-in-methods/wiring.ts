import { secretBox } from "@/config/keys";
import { tenantsService } from "@/config/tenancy";
import { SignInPolicyService } from "@/modules/sign-in-methods/service";

/** The sign-in policy service on the app's tenants service and secret box. */
export const signInPolicyService = new SignInPolicyService(
  tenantsService,
  secretBox,
);
