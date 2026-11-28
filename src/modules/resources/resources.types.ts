import type { ReadDocumentOf, TypedCollection } from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { z } from "zod";
import type { CliTenant } from "@/shared/cli";
import type { Translation } from "@/shared/translations";
import type { DetailTypeClients } from "./resources.client-lists";
import type {
  detailTypes,
  FieldKind,
  resources,
  scopes,
} from "./resources.model";

export type StoredResourceDoc = ReadDocumentOf<typeof resources>;
export type StoredScopeDoc = ReadDocumentOf<typeof scopes>;
export type StoredDetailTypeDoc = ReadDocumentOf<typeof detailTypes>;

/** A text as a caller sends it: the locales it sets (see `mergeTranslations`). */
export type Texts = readonly Translation[];

export interface ScopeInput {
  name: string;
  description?: Texts | undefined;
  /** The resource it belongs to; `null` for a standard OpenID Connect scope. */
  resourceId?: string | null | undefined;
  claims?: readonly string[] | undefined;
}

export interface ValueDraft {
  value: string;
  label?: Texts | undefined;
}

export interface FieldDraft {
  key: string;
  kind: FieldKind;
  label?: Texts | undefined;
  required?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
  values?: readonly ValueDraft[] | undefined;
}

/** What the console sends to create a detail type. */
export interface DetailTypeDraft {
  type: string;
  name: Texts;
  description?: Texts | undefined;
  fields: readonly FieldDraft[];
  actions?: readonly ValueDraft[] | undefined;
}

/** What it sends to change one: the type name never changes; a part left out stays. */
export interface DetailTypePatch {
  name?: Texts | undefined;
  description?: Texts | undefined;
  fields?: readonly FieldDraft[] | undefined;
  actions?: readonly ValueDraft[] | undefined;
}

/** A detail type as stored, minus what the store adds. */
export type DetailTypeInput = Omit<
  StoredDetailTypeDoc,
  "_id" | "id" | "tenantId" | "resourceId" | "createdAt" | "updatedAt"
>;

/** What a resource's `authorizationDetails` holds (janus's declaration). */
export type CompiledDetailTypes = Record<string, { schema: z.ZodType }>;

export interface ResourcesServiceOptions {
  resources: TypedCollection<typeof resources>;
  scopes: TypedCollection<typeof scopes>;
  detailTypes: TypedCollection<typeof detailTypes>;
  /** The clients' lists of detail types (D6, and the pruning of a deleted resource's). */
  clients: DetailTypeClients;
  /** The tenant's userinfo URL, a built-in resource that cannot be registered. */
  userinfoOf: (tenantSlug: string) => string;
  /** A tenant by slug, for `registerResource` (the `resources:create` script). */
  findTenant: (slug: string) => Promise<CliTenant | undefined>;
  /**
   * Told which scopes a replace of a resource's scopes dropped, before they are
   * removed, so that no role keeps holding them (the roles' `pullScopes`, which
   * also records the audit; bound in `config/resources.ts`).
   */
  scopesDropped: (
    tenantId: ObjectId,
    scopeIds: readonly ObjectId[],
  ) => Promise<void>;
}

export interface RegisterResourceInput {
  /** The tenant's slug. */
  tenant: string;
  /** The resource's URI: the `aud` of its access tokens, and the key of idempotency. */
  uri: string;
  /** Default: the URI's host. */
  name?: string;
  /** What a client may request on it (at least one). Re-running replaces the list. */
  scopes: readonly string[];
}

export interface RegisteredResource {
  created: boolean;
  tenant: string;
  uri: string;
  name: string;
  scopes: readonly string[];
}
