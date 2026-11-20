import { NoSchemaIntrospectionCustomRule, type ValidationRule } from "graphql";

/**
 * A GraphQL plugin that refuses `__schema` and `__type` (graphql-js's own
 * rule): the hosted `/graphql` does not hand its schema to whoever asks
 * outside development. It hides the schema, it is not authorisation.
 */
export function useNoIntrospection() {
  return {
    onValidate({
      addValidationRule,
    }: {
      addValidationRule: (rule: ValidationRule) => void;
    }) {
      addValidationRule(NoSchemaIntrospectionCustomRule);
    },
  };
}
