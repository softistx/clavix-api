import type { GraphQLSchema } from "graphql";

/** What was done, `<noun>.<verb>`: `tenant.create`, `client.rotateSecret`. */
export const AUDIT_ACTION = /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/;

/** An action's name; `AUDIT_ACTION` is its exact form (camelCase segments). */
export type AuditAction = `${string}.${string}`;

/**
 * What an action was done to: its kind and id, and the tenant it belongs to
 * (hex id; `null` for a target of the platform itself, such as an operator).
 * Identifiers only: never a secret, a token or a value that changed.
 */
export interface AuditTarget {
  type: string;
  id: string;
  tenantId: string | null;
}

/** `ctx.audit`: appends one admin event for the caller. Await it. */
export type Audit = (action: AuditAction, target: AuditTarget) => Promise<void>;

/**
 * The audit action of each mutation, keyed `Mutation.createTenant`. Every
 * `Mutation` root field of the console API must have one (audit.spec.ts).
 */
export type Audits = Readonly<Record<string, AuditAction>>;

/** What is wrong between a schema's mutations and the declared actions. */
export interface AuditProblems {
  /** `Mutation` root fields with no declared action. */
  undeclared: string[];
  /** Declarations that name no `Mutation` root field (a typo, a removed field). */
  stray: string[];
  /** Declarations whose action is not `<noun>.<verb>`. */
  malformed: string[];
}

/** Walks the schema's `Mutation` root fields against `audits`. */
export function auditProblems(
  schema: GraphQLSchema,
  audits: Audits,
): AuditProblems {
  const mutation = schema.getMutationType();
  const fields =
    mutation === undefined || mutation === null
      ? []
      : Object.keys(mutation.getFields()).map((f) => `${mutation.name}.${f}`);
  return {
    undeclared: fields.filter((field) => !Object.hasOwn(audits, field)),
    stray: Object.keys(audits).filter((key) => !fields.includes(key)),
    malformed: Object.entries(audits)
      .filter(([, action]) => !AUDIT_ACTION.test(action))
      .map(([key]) => key),
  };
}
