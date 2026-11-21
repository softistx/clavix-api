import type { ReadDocumentOf, TypedCollection } from "@softistx/mongo";
import type { z } from "zod";
import type { CliTenant } from "@/shared/cli";
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

export interface Description {
  fr: string;
  en: string;
}

/** A text to set; a language left out (or `undefined`) is not touched. */
export interface DescriptionInput {
  fr?: string | undefined;
  en?: string | undefined;
}

export interface ScopeInput {
  name: string;
  description?: DescriptionInput | undefined;
  /** The resource it belongs to; `null` for a standard OpenID Connect scope. */
  resourceId?: string | null | undefined;
  claims?: readonly string[] | undefined;
}

/** A label or a description in the draft: a language left out is empty. */
export interface TextDraft {
  fr?: string | undefined;
  en?: string | undefined;
}

export interface ValueDraft {
  value: string;
  label?: TextDraft | undefined;
}

export interface FieldDraft {
  key: string;
  kind: FieldKind;
  label?: TextDraft | undefined;
  required?: boolean | undefined;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
  values?: readonly ValueDraft[] | undefined;
}

/** What the console sends to create a detail type. */
export interface DetailTypeDraft {
  type: string;
  name: TextDraft;
  description?: TextDraft | undefined;
  fields: readonly FieldDraft[];
  actions?: readonly ValueDraft[] | undefined;
}

/** What it sends to change one: the type name never changes; a part left out stays. */
export interface DetailTypePatch {
  name?: DescriptionInput | undefined;
  description?: DescriptionInput | undefined;
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
