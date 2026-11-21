import { denial } from "@softistx/janus-graphql";
import { tenantsService } from "@/config/tenancy";
import { usageService } from "@/config/usage";
import { refusal } from "@/console/modules/refusal";
import { assertWithinQuota, QuotaExceededError } from "@/modules/usage";

/** Clients are a hard quota: one more past the plan's is `QUOTA_EXCEEDED` (409). */
export async function assertClientQuota(tenant: {
  _id: { toHexString(): string };
}) {
  const id = tenant._id.toHexString();
  const doc = await tenantsService.find(id);
  if (doc === undefined) throw denial("NOT_FOUND", "No such tenant");
  try {
    assertWithinQuota(
      "clients",
      await usageService.count(id, "clients"),
      usageService.quotasOf(doc).clients,
    );
  } catch (error) {
    if (error instanceof QuotaExceededError) throw refusal(error);
    throw error;
  }
}
