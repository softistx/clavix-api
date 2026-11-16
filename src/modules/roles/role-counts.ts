import type { TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { roleAssignments } from "./roles.model";
import type { RoleDoc } from "./roles.service";

/** The holders of each role in one query, by role id (hex); a role nobody holds counts 0. */
export async function memberCounts(
  assignments: TypedCollection<typeof roleAssignments>,
  tenantId: ObjectId,
  found: readonly RoleDoc[],
): Promise<Map<string, number>> {
  const counts = new Map(found.map((role) => [role._id.toHexString(), 0]));
  if (found.length === 0) return counts;
  // Grouped on the server; the tenant is in the match, as a scope would put it.
  const grouped = await assignments.raw
    .aggregate<{ _id: ObjectId; n: number }>([
      { $match: { tenantId, roleId: { $in: found.map((r) => r._id) } } },
      { $group: { _id: "$roleId", n: { $sum: 1 } } },
    ])
    .toArray();
  for (const { _id, n } of grouped) counts.set(_id.toHexString(), n);
  return counts;
}
