import type { TxtResolver } from "./dns";
import { txtNameOf } from "./domain-host";
import type { DomainDoc } from "./domains.model";

export type CheckFailure = "NO_RECORD" | "MISMATCH" | "LOOKUP_FAILED";

/** Reads `_clavix.<host>` and compares it with the claim's token: `null` when it is there. */
export async function checkClaim(
  dns: TxtResolver,
  claim: Pick<DomainDoc, "host" | "txtToken">,
): Promise<CheckFailure | null> {
  const answer = await dns.resolveTxt(txtNameOf(claim.host));
  if (answer.kind === "failed") return "LOOKUP_FAILED";
  if (answer.kind === "none" || answer.values.length === 0) return "NO_RECORD";
  return answer.values.some((value) => value.trim() === claim.txtToken)
    ? null
    : "MISMATCH";
}
