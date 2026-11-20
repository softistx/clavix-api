/** Whether a `content-type` is a JSON GraphQL answer: `application/json` or `application/graphql-response+json`, parameters ignored. */
export function isJsonAnswer(contentType: string | null): boolean {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return (
    type === "application/json" || type === "application/graphql-response+json"
  );
}
