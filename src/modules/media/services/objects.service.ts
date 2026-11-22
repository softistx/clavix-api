import { fail } from "@/shared/errors";
import type { MediaStore } from "../media.bucket";
import { avatarObjectKey, tenantListPrefix } from "../media.utils";

const PAGE = 500;

/**
 * The picture objects of the bucket: removing one, and removing a whole
 * tenant's folder. A failed removal of one a user asked to erase is a 503
 * (the caller retries); the removal of a replaced picture is best effort and
 * logged, since the new picture is already in place.
 */
export class AvatarObjectsService {
  constructor(
    private readonly store: MediaStore,
    private readonly log: (message: string) => void,
  ) {}

  /** Removes a picture's object; a storage failure is a 503. */
  async remove(tenantId: string, key: string): Promise<void> {
    try {
      await this.store.delete({ key: avatarObjectKey(tenantId, key) });
    } catch (error) {
      this.log(`avatar object not removed: ${String(error)}`);
      throw fail("SERVICE_UNAVAILABLE", "Pictures are unavailable", {
        status: 503,
      });
    }
  }

  /** Removes the object a picture change replaced; a failure is logged, never thrown. */
  async removeFormer(tenantId: string, key: string | null): Promise<void> {
    if (key === null) return;
    try {
      await this.store.delete({ key: avatarObjectKey(tenantId, key) });
    } catch (error) {
      this.log(`former avatar object not removed: ${String(error)}`);
    }
  }

  /** Removes every object under the tenant's folder; the count removed. */
  async purgeTenant(tenantId: string): Promise<number> {
    const prefix = tenantListPrefix(tenantId);
    let removed = 0;
    let cursor: string | null = null;
    do {
      const page = await this.store.list({ prefix, limit: PAGE, cursor });
      for (const item of page.items) {
        await this.store.delete({ key: item.key });
        removed += 1;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return removed;
  }
}
