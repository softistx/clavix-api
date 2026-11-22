import { AccountService } from "@/modules/account";
import { attributeValuesService } from "./attributes";
import { exclusive } from "./exclusive";
import { tenantMail } from "./mail";
import { profilePoliciesService } from "./profile";
import { clock, warn } from "./runtime";
import { janusIssuers } from "./users";

/** The signed-in user's own profile, attributes and e-mail change, over the tenants' janus instances and mail. */
export const accountService = new AccountService({
  now: clock,
  log: warn,
  issuers: janusIssuers,
  mailOf: tenantMail,
  profilePolicies: profilePoliciesService,
  values: attributeValuesService,
  exclusive,
});
