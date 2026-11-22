// The module's import surface (attributes: a tenant's catalogue of user
// attributes). `attributes.console-resolver` is loaded by file by
// `console/modules/index.ts`; the hosted API has no attributes resolver.
// `config/attributes.ts` builds the service.

export { AttributesService } from "./attributes.service";
export type { AttributeValues } from "./attributes.types";
export { AttributeValuesService } from "./values.service";
export { exportedView } from "./values.utils";
