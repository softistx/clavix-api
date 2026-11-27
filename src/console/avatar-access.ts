import { MediaRefusal } from "@softistx/alxia-media";
import type { AvatarRecorder } from "@/modules/media";
import { permitted } from "./guard";
import { CONSOLE_AVATAR_PATH } from "./identity";
import type { Permission } from "./model";
import { authenticated, type ConsoleDeps } from "./plugin";

// The media refusal a refused console token is answered with.
const refusedAs = (response: Response) =>
  new MediaRefusal(response.status === 503 ? "unavailable" : "unauthenticated");

/**
 * Whether a console caller may write a user's picture
 * (`PUT /media/avatar?tenantId=&userId=`): the same rule as the console's own
 * `edit` on the tenant (`permitted`), checked like the audit export. Resolves
 * with the recorder of the caller's `user.setPicture` admin event (called once
 * the picture is stored, ids only); else throws the media refusal that says why not. Without the
 * console (`undefined`) there is no such route: `not_found`.
 *
 * The token first, then the verified e-mail, then the role (so a caller with
 * no right learns nothing of the tenant), then the tenant: a suspended one
 * stays read-only unless the platform's `edit` is held.
 */
export function consoleAvatarAccess(deps: ConsoleDeps | undefined) {
  return async (
    request: Request,
    tenantId: string,
  ): Promise<AvatarRecorder> => {
    if (deps === undefined) throw new MediaRefusal("not_found");
    const principal = await authenticated(
      deps.authenticate,
      deps.reportError,
      request,
      CONSOLE_AVATAR_PATH,
    );
    if (principal instanceof Response) throw refusedAs(principal);
    const { userId: caller } = principal;
    if (!(await deps.directory.emailVerified(caller))) {
      throw new MediaRefusal("forbidden");
    }
    const [tenant] = await deps.directory.tenantsByIds([tenantId]);
    const who = {
      can: (wanted: Permission, id: string) =>
        deps.access.can(caller, wanted, id),
      canPlatform: (wanted: Permission) =>
        deps.access.canPlatform(caller, wanted),
    };
    if (!(await permitted(who, "edit", tenantId, tenant))) {
      throw new MediaRefusal("forbidden");
    }
    if (tenant === undefined) throw new MediaRefusal("not_found");
    if (tenant.status === "suspended" && !(await who.canPlatform("edit"))) {
      throw new MediaRefusal("forbidden");
    }
    return (userId) =>
      deps.adminEvents.record({
        actor: caller,
        action: "user.setPicture",
        tenantId,
        target: { type: "user", id: userId },
        requestId: crypto.randomUUID(),
      });
  };
}
