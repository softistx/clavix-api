// The module's import surface. `resources.console-resolver` is loaded by file by
// `console/modules/index.ts`.

export * from "./resources.cli";
export { mongoDetailTypeClients } from "./resources.client-lists";
export * from "./resources.client-opt-in";
export { digestOf } from "./resources.compile";
export { CatalogError, codes } from "./resources.errors";
export {
  detailTypes,
  type FieldKind,
  resources,
  scopes,
} from "./resources.model";
export { DPOP_ALGORITHMS } from "./resources.protected-document";
export { OIDC_SCOPES } from "./resources.rules";
export * from "./resources.service";
export {
  cleanTranslations,
  mergeTranslations,
} from "./resources.translation-rules";
export type { RegisterResourceInput } from "./resources.types";
export { scopeShape } from "./resources.utils";
