// The module's import surface (attributes: a tenant's catalogue of user
// attributes and the values users hold). Role files with several members are
// folders with a barrel (`services/`, `rules/`, `utils/`).
// `attributes.console-resolver` is loaded by file by `console/modules/index.ts`;
// the hosted API has no attributes resolver. `config/attributes.ts` builds the
// services.

export type { AttributeValues } from "./attributes.types";
export { AttributesService, AttributeValuesService } from "./services";
export { exportedView } from "./utils";
