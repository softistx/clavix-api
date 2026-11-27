import type { Exclusive } from "@/console/exclusive";
import type { AttributeValuesService } from "@/modules/attributes";
import type { AuthPorts } from "@/modules/auth";
import type { ProfilePoliciesService } from "@/modules/profile";

/** What `AccountService` is built over: the tenants' janus instances and mail, the locks and the values. */
export interface AccountPorts {
  /** The janus instance of the request's host; `null` for a host that names no active tenant. */
  issuers: AuthPorts["issuers"];
  /** The e-mails of a tenant, from its own sender. */
  mailOf: AuthPorts["mailOf"];
  /** The tenant's profile locks. */
  profilePolicies: Pick<ProfilePoliciesService, "lockedFor">;
  /** The attribute values users hold. */
  values: Pick<AttributeValuesService, "checkEditable" | "editableOf" | "save">;
  /** One at a time per key: a user's own writes run under their `userKey`, as the console's do. */
  exclusive: Exclusive;
  /** The current time. */
  now: () => Date;
  /** Where a mail that was not sent is logged (by its error name only). */
  log: (message: string) => void;
}
