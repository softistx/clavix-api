import type { Passkey } from "@softistx/janus";
import { oauthDb } from "@/config/oauth-db";
import type { TenantJanus } from "@/modules/users";
import { quietJanus } from "~/ports";
import { tenantStandIn } from "~/spec-context";

/** What `TenantJanus.authenticate` answers for a signed-in request. */
export type Signed = NonNullable<
  Awaited<ReturnType<TenantJanus["authenticate"]>>
>;

/** A signed-in request's session as janus answers it, for the user `id` (a verified e-mail, no second factor). */
export function signedAs(id: string, email = `${id}@x.test`): Signed {
  const now = new Date("2026-11-20T00:00:00Z");
  return {
    via: "session",
    user: {
      id,
      type: "user",
      email,
      emailVerified: true,
      active: true,
      hasPassword: false,
      hasSecondFactor: false,
      avatar: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `s-${id}`,
      userId: id,
      authenticatedAt: now,
      expiresAt: new Date("2026-12-20T00:00:00Z"),
      revokedAt: null,
      createdAt: now,
      amr: [],
    },
    token: "token",
    renewed: false,
  };
}

/**
 * A real `TenantJanus` (every port quiet, never reached by a spec that only
 * checks what comes before janus is asked) with the members the spec fakes
 * laid over a copy of it (janus's own instance is frozen).
 */
export const janusOver = (fake: Partial<TenantJanus> = {}): TenantJanus => ({
  ...quietJanus(oauthDb, tenantStandIn()),
  ...fake,
});

/** A passkey as janus stores it, the fields the spec names laid over a laptop's. */
export const passkeyOf = (fields: Partial<Passkey> = {}): Passkey => ({
  credentialId: "cred",
  userId: "u1",
  name: "Laptop",
  transports: ["internal"],
  aaguid: "00000000-0000-0000-0000-000000000000",
  backupEligible: true,
  backedUp: false,
  createdAt: new Date("2026-11-20T00:00:00Z"),
  lastUsedAt: null,
  ...fields,
});
