import type { ConsoleUsers } from "../../context";
import type { Pool } from "./pool";

/** The OAuth grants of `ConsoleUsers`: a user's list and one revoked. */
export const poolGrants = ({
  grants,
}: Pool): Pick<ConsoleUsers, "grants" | "revokeGrant"> => ({
  async grants(tenantId, userId) {
    return [...(await (await grants(tenantId)).list({ id: userId }))];
  },
  async revokeGrant(tenantId, userId, grantId) {
    return (await grants(tenantId)).revoke({ id: userId }, grantId);
  },
});
