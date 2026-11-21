import type { Context } from "@/http/context";
import { fail } from "@/shared/errors";
import { requireLive } from "@/tenancy/live";
import type { ResolvedTenant } from "@/tenancy/resolved-tenant";
import { agentMarksReader, markOf } from "./consent.agent-marker";
import { assessment, type RequestDemands } from "./consent.authentication";
import { type DetailTexts, reviewDetails } from "./consent.detail-labels";
import { refuseIncomplete, unmetAuthentication } from "./consent.errors";
import type { ScopeTexts } from "./consent.scope-labels";
import { textOf } from "./consent.scope-labels";
import type {
  ApproveArgs,
  ConsentCtx,
  ConsentOptions,
  LabelledScope,
  RevokeEnqueuer,
  RevokeJob,
  RevokeWorkerQueue,
  WithServers,
} from "./consent.types";
import { denyUnreachable, isUnreachable } from "./consent.unmet";
import { localeOfCtx, perRequest, requestOf } from "./consent.utils";

/**
 * The consent API of the hosted `/consent` page: the request host's OAuth
 * server, the approval hooks (the tenant's mode, the request's `acr_values`,
 * the details in words), the fields the page reads (labelled scopes, details,
 * authentication, agent mark), the revocation of a replaced holder's grants and
 * its retry queue. Both the OAuth server and the signed-in user are the request
 * host's tenant's, so a request id or a session of another tenant is unknown.
 */
export class ConsentService {
  // One read of the tenant's texts and of a client's agent mark per request,
  // shared by the fields of a page.
  private readonly readTexts = perRequest<ScopeTexts>();
  private readonly readDetailTexts = perRequest<DetailTexts>();
  private readonly readAgents = agentMarksReader();
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor({ log, now }: ConsentOptions) {
    this.log = log;
    this.now = now;
  }

  /** The OAuth server of the request's host, for a live tenant (`NOT_FOUND` otherwise). */
  async serverOf(ctx: unknown) {
    // The same-origin guard ran at the HTTP layer (`useSameOriginJson`, src/http/same-origin.ts).
    const request = requestOf(ctx);
    const server = await (ctx as WithServers).oauthServers.serverFor(request);
    if (server === null) throw fail("NOT_FOUND", "Not found", { status: 404 });
    // A code is not minted for a suspended or deleted tenant.
    requireLive(
      await (
        ctx as unknown as { tenant: () => Promise<ResolvedTenant> }
      ).tenant(),
    );
    return server;
  }

  /**
   * Before each lookup of a user code on the device page, the signed-in user,
   * the client address and the tenant are counted (hit or miss: janus calls
   * the hook before it reads the store). The viewer is known to be signed in,
   * and the tenant live, when it runs.
   */
  async countLookup(ctx: unknown): Promise<void> {
    const { tenant, ip, deviceThrottle, janus } = ctx as Context;
    const [current, resolved] = await Promise.all([janus.user(), tenant()]);
    if (current === null || resolved === null)
      throw fail("NOT_FOUND", "Not found", { status: 404 });
    await deviceThrottle.check({
      tenantId: resolved.tenantId,
      userId: current.id,
      ip,
    });
  }

  /**
   * Once per approval, in both flows, after the viewer and session checks:
   * a selection of details is refused (all or nothing, D4); the tenant's mode
   * and the request's `acr_values`, `max_age` and `prompt=login` must be met
   * (D7, D10); every detail must be fully described.
   */
  async beforeApprove(
    { request, authorizationDetails: selection }: ApproveArgs,
    ctx: unknown,
  ): Promise<void> {
    if (selection !== undefined) throw refuseIncomplete();
    const authentication = await assessment(
      ctx as Context,
      request,
      this.now(),
    );
    if (!authentication.met) throw unmetAuthentication(authentication.missing);
    if (request.authorizationDetails === undefined) return;
    const json = JSON.stringify(request.authorizationDetails);
    const { complete } = await this.review(json, ctx as ConsentCtx);
    if (!complete) throw refuseIncomplete();
  }

  /** How the viewer authenticated (D9): the session's methods as `amr`, its level as `acr`, the time of its last proof as `auth_time`. */
  async approveOptions({ request }: ApproveArgs, ctx: unknown) {
    const { amr, acr, authTime } = await assessment(
      ctx as Context,
      request,
      this.now(),
    );
    return { amr, acr, authTime };
  }

  /**
   * Runs the approval; a request whose `acr_values` Clavix cannot issue is
   * denied to the client (`unmet_authentication_requirements`), whose answer
   * is its redirect. A gap the user can close stays a refusal of the call.
   */
  async approveOrDenyUnmet(
    approve: () => Promise<{ redirectTo: string }>,
    id: string,
    ctx: unknown,
  ): Promise<{ redirectTo: string }> {
    try {
      return await approve();
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      return denyUnreachable(await this.serverOf(ctx), id);
    }
  }

  /** The scopes of a pending request or a connected app, relabelled with the tenant's descriptions in the viewer's language. */
  async scopes(
    parent: { resource: string; scopes: LabelledScope[] },
    ctx: ConsentCtx,
  ): Promise<LabelledScope[]> {
    const texts = await this.readTexts(ctx.request, ctx.scopeTextsFor);
    if (texts === undefined) return parent.scopes;
    const locale = localeOfCtx(ctx);
    return parent.scopes.map((scope) => ({
      name: scope.name,
      label:
        textOf(
          texts,
          { name: scope.name, resource: parent.resource },
          locale,
        ) ?? scope.label,
    }));
  }

  /** The details of a request in words (D5), never the raw JSON. */
  async details(
    parent: { authorizationDetails?: string | null },
    ctx: ConsentCtx,
  ) {
    return (await this.review(parent.authorizationDetails, ctx)).details;
  }

  /** Whether every detail of a request is fully described; approval is refused otherwise. */
  async detailsComplete(
    parent: { authorizationDetails?: string | null },
    ctx: ConsentCtx,
  ) {
    return (await this.review(parent.authorizationDetails, ctx)).complete;
  }

  /** The `authentication` field of a pending request: what it asks, what the session reached, what is missing. */
  async authentication(parent: RequestDemands, ctx: Context) {
    const out = await assessment(ctx, parent, this.now());
    return {
      acr: out.required,
      current: out.reached,
      maxAge: out.maxAge,
      met: out.met,
      missing: out.missing,
    };
  }

  /** Whether the client is an agent of the tenant, and since when (`OAuthClient.agent`, `registeredAt`). */
  async agent(parent: { id: string }, ctx: ConsentCtx) {
    const marks = await this.readAgents(ctx.request, ctx.agentsFor, parent.id);
    return markOf(marks, parent.id);
  }

  /**
   * Revokes every standing OAuth grant of `userId` on the request's tenant,
   * with the access and refresh tokens they opened; answers how many grants it
   * revoked. Nothing to revoke where no OAuth server is mounted.
   */
  async revokeGrants(ctx: Context, userId: string): Promise<number> {
    if ((ctx as unknown as WithServers).oauthServers === undefined) return 0;
    return (await this.serverOf(ctx)).grants.revokeAll({ id: userId });
  }

  /**
   * Revokes the replaced holder's grants now; when that fails, the revocation
   * is put on the retryable queue and the sign-in goes on once the job is
   * stored. With no queue, or when the queue cannot be written, the original
   * failure propagates and the sign-in fails (janus does not repeat
   * `replaced`, so a retried sign-in would not revoke).
   */
  async revokeOnReplace(
    ctx: Context,
    tenantId: string,
    userId: string,
    queue: RevokeEnqueuer | undefined,
  ): Promise<void> {
    try {
      await this.revokeGrants(ctx, userId);
    } catch (error) {
      if (queue === undefined) throw error;
      try {
        await queue.add({ tenantId, userId });
      } catch (queueError) {
        this.log(`grants: revocation not queued: ${String(queueError)}`);
        throw error;
      }
      this.log(`grants: revocation queued after a failure: ${String(error)}`);
    }
  }

  /**
   * Runs each queued revocation; a failure throws so the queue retries it with
   * backoff. The server starts it only with a queue (no Redis, no worker).
   */
  startRevokeWorker(
    run: (job: RevokeJob) => Promise<number>,
    queue: RevokeWorkerQueue,
  ): void {
    queue
      .work(async ({ data }) => {
        await run(data);
      })
      .on("error", (error) => this.log(`grants: ${String(error)}`));
  }

  // The details of a pending request or device request, in words (D5), and
  // whether every one is fully described.
  private async review(
    authorizationDetails: string | null | undefined,
    ctx: ConsentCtx,
  ) {
    const texts =
      (await this.readDetailTexts(ctx.request, ctx.detailTextsFor)) ?? [];
    return reviewDetails(authorizationDetails ?? null, texts, localeOfCtx(ctx));
  }
}
