import { tenantsService } from "@/config/tenancy";
import { OAuthPolicyService } from "@/modules/oauth-policy/service";

/** The OAuth policy service on the app's tenants service. */
export const oauthPolicyService = new OAuthPolicyService(tenantsService);
