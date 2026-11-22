import type { BaseContext } from "@softistx/alxia";
import { MediaRefusal } from "@softistx/alxia-media";
import { isLive, type ResolvedTenant } from "@/tenancy/resolved-tenant";
import { adminQueryOf, crossSite } from "../media.access";
import type { AvatarAccessPorts, AvatarTarget } from "../media.types";

/** What the access reads of a request's context. */
export type AccessContext = Pick<BaseContext, "request" | "url"> & {
  tenant(): Promise<ResolvedTenant | null>;
};

/**
 * Whose picture a request writes, decided once per request: the signed-in
 * user's own on the tenant host (session cookie), or the user a console caller
 * names (`?tenantId=&userId=`, bearer token, `edit` on the tenant). Every
 * refusal is a `MediaRefusal`, so nothing is written for a denied request.
 */
export class AvatarAccessService {
  private readonly targets = new WeakMap<Request, Promise<AvatarTarget>>();

  constructor(private readonly ports: AvatarAccessPorts) {}

  /** The target of the request, resolved on the first call and shared by the later ones. */
  targetOf(ctx: AccessContext): Promise<AvatarTarget> {
    let target = this.targets.get(ctx.request);
    if (target === undefined) {
      target = this.resolve(ctx);
      this.targets.set(ctx.request, target);
    }
    return target;
  }

  private async resolve(ctx: AccessContext): Promise<AvatarTarget> {
    const named = adminQueryOf(ctx.url);
    if (named === null) return this.own(ctx);
    await this.ports.admin(ctx.request, named.tenantId);
    const auth = await this.ports.janusOf(named.tenantId);
    if (auth === null) throw new MediaRefusal("not_found");
    return { ...named, auth };
  }

  private async own(ctx: AccessContext): Promise<AvatarTarget> {
    if (crossSite(ctx.request)) throw new MediaRefusal("forbidden");
    const [tenant, auth] = await Promise.all([
      ctx.tenant(),
      this.ports.issuers.forRequest(ctx.request),
    ]);
    if (tenant === null || auth === null) throw new MediaRefusal("not_found");
    const current = await auth.authenticate(ctx.request);
    if (current === null) throw new MediaRefusal("unauthenticated");
    if (!isLive(tenant)) throw new MediaRefusal("forbidden");
    return { tenantId: tenant.tenantId, userId: current.user.id, auth };
  }
}
