import type { OAuthHandle } from "@/oauth/routes";
import type { AgentsFor } from "./consent.agent-marker";
import type { RequestDemands } from "./consent.authentication";
import type { DetailTextsFor } from "./consent.detail-labels";
import type { ScopeTextsFor } from "./consent.scope-labels";

/** The OAuth servers the app serves, by the request's host. */
export type ServerSource = Required<Pick<OAuthHandle, "serverFor">>;

/**
 * What `oauthContext` puts on the GraphQL context: the OAuth servers, which
 * the resolvers pick from by the request's host, and the readers of the
 * tenants' scope texts, detail type texts and agents.
 */
export type WithServers = {
  oauthServers?: ServerSource;
  scopeTextsFor?: ScopeTextsFor;
  detailTextsFor?: DetailTextsFor;
  agentsFor?: AgentsFor;
};

/** A context as the consent fields read it: the readers and the request. */
export type ConsentCtx = WithServers & { request?: Request };

/** What a queued revocation carries: ids only. */
export interface RevokeJob {
  tenantId: string;
  userId: string;
}

/** The queue surface the sign-in needs (`redis.queues.grantsRevoke`). */
export interface RevokeEnqueuer {
  add(data: RevokeJob): Promise<unknown>;
}

/** The queue surface the worker needs. */
export interface RevokeWorkerQueue {
  work(handler: (job: { data: RevokeJob }) => Promise<unknown>): {
    on(event: "error", fn: (e: unknown) => void): unknown;
  };
}

/** A scope as janus-oauth lists it on a request or a connected app. */
export interface LabelledScope {
  name: string;
  label: string;
}

/** What `ConsentService` is built with. */
export interface ConsentOptions {
  /** Where a queued or failed revocation is logged (a warning by default). */
  log?: (message: string) => void;
}

/** What janus-oauth hands the approval hooks: the pending request and a selection of details, if any. */
export interface ApproveArgs {
  request: RequestDemands & { authorizationDetails?: unknown };
  authorizationDetails?: unknown;
}
