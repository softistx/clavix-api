// The module's import surface (attributes: a tenant's catalogue of user
// attributes and the values users hold). Role files with several members are
// folders with a barrel (`services/`, `rules/`, `utils/`).
// `attributes.console-resolver` is loaded by file by `console/modules/index.ts`;
// the hosted API has no attributes resolver. `config/attributes.ts` builds the
// services. Allowed deep imports: `attributes.errors` (a leaf file, read by
// `i18n/codes.ts`) and `attributes.console-resolver` (read by
// `console/modules/lock-order.spec.ts`).

export {
  AttributeClaimsService,
  AttributesService,
  AttributeValuesService,
  RoleAttributesService,
} from "./services";
export { exportedView } from "./utils";
