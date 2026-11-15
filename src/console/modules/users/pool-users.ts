import { JanusError } from "@softistx/janus";
import type { ConsoleUsers } from "../../context";
import { type Pool, view } from "./pool";

/** The user records of `ConsoleUsers`: reads, the flags, the name and the deletion. */
export const poolUsers = ({
  janus,
  grants,
}: Pool): Pick<
  ConsoleUsers,
  | "list"
  | "count"
  | "find"
  | "findByEmail"
  | "setEmailVerified"
  | "setActive"
  | "rename"
  | "delete"
> => ({
  async list(tenantId, { after, limit, emailPrefix }) {
    const page = await (await janus(tenantId)).list({
      after,
      limit,
      ...(emailPrefix === undefined ? {} : { emailPrefix }),
    });
    return { items: page.items.map(view), nextCursor: page.nextCursor };
  },
  async count(tenantId, { emailPrefix } = {}) {
    return (await janus(tenantId)).count(
      emailPrefix === undefined ? {} : { emailPrefix },
    );
  },
  async find(tenantId, id) {
    const user = await (await janus(tenantId)).findUser(id);
    return user === null ? null : view(user);
  },
  async findByEmail(tenantId, email) {
    const user = await (await janus(tenantId)).findByEmail(email);
    return user === null ? null : view(user);
  },
  async setEmailVerified(tenantId, id, verified) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return null;
    try {
      return view(await auth.setEmailVerified(user, verified));
    } catch (error) {
      if (error instanceof JanusError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  },
  async setActive(tenantId, id, active) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return null;
    try {
      const written =
        user.active === active ? user : await auth.setActive(user, active);
      // A disabled user keeps no session: ended on a repeat too.
      if (!active) await auth.signOutEverywhere(user.id);
      return view(written);
    } catch (error) {
      if (error instanceof JanusError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  },
  async rename(tenantId, id, name) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return null;
    try {
      return view(
        user.name === name ? user : await auth.update(user, { name }),
      );
    } catch (error) {
      if (error instanceof JanusError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  },
  async delete(tenantId, id) {
    const auth = await janus(tenantId);
    const user = await auth.findUser(id);
    if (user === null) return false;
    // Grants and their tokens first: a failure here leaves the user to retry.
    await (await grants(tenantId)).revokeAll({ id });
    await auth.signOutEverywhere(id);
    return auth.delete(user);
  },
});
