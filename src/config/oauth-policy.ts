import { OAuthPolicyService } from "@/modules/oauth-policy";
import { tenantsService } from "./tenancy";

/** The OAuth policy service on the app's tenants service. */
export const oauthPolicyService = new OAuthPolicyService(tenantsService);
