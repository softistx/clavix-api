import { deleteClient } from "@softistx/janus-oauth";
import type { createMongoOAuth } from "@softistx/janus-oauth-mongo";
import type { CliTenant } from "@/cli/errors";
import type { ClientPoliciesService } from "@/modules/client-policies/client-policies.service";

/**
 * Deletes the client. `unmanaged` is a record this service does not manage (not
 * registered through the console or the script): it is left alone, and the
 * caller has nothing to record. `removed` is `false` when it was not there.
 * One read decides both, so the answer cannot disagree with what was done.
 * The client goes first (nothing new can be granted to it), then its
 * standing grants and their tokens are revoked: on a repeat too, so a run
 * that stopped between the two is finished.
 */
export async function deleteClientAndRules(
  store: ReturnType<typeof createMongoOAuth>,
  policies: ClientPoliciesService,
  tenant: CliTenant,
  clientId: string,
  now: Date,
): Promise<{ removed: boolean; unmanaged: boolean }> {
  const record = await store.findClient(clientId);
  if (record !== null && record.source !== "registered") {
    return { removed: false, unmanaged: true };
  }
  const removed = await deleteClient(store, clientId, { now });
  // The client's rules (`clientPolicies`) go with it, on a repeat too.
  await policies.deleteForClient(tenant._id, clientId);
  // And it leaves the other clients' rules that name it as a subject.
  await policies.removeSubjectClient(tenant._id, clientId);
  return { removed, unmanaged: false };
}
