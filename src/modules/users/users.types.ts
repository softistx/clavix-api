import type { OAuthGrants } from "@softistx/janus-oauth";
import type { TenantInvitations } from "@/modules/invitations/invitations.types";
import type { TenantJanus } from "./tenant-janus";

/** Where `UsersService` reaches a tenant's pool; `null` for a tenant that is gone or suspended. */
export interface UsersSource {
  janusOf(tenantId: string): Promise<TenantJanus | null>;
  grantsOf(tenantId: string): Promise<OAuthGrants | null>;
  invitationsOf(tenantId: string): TenantInvitations;
}

/** A user as the console resolvers pass it on: its tenant too, for the fields read afterwards (`secondFactor`). */
export interface TenantUserParent {
  tenantId: string;
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  active: boolean;
  createdAt: Date;
}
