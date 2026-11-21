import { OAuthPolicyService } from "@/modules/oauth-policy/oauth-policy.service";
import { tenantsService } from "./tenancy";

/** The OAuth policy service on the app's tenants service. */
export const oauthPolicyService = new OAuthPolicyService(tenantsService);
