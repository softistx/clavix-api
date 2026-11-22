import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { detailTypeDoc, scopeDoc } from "~/resource-docs";
import {
  detailTypeShape,
  fieldDraft,
  scopeShape,
  target,
  valueDraft,
} from "./resources.utils";

describe("fieldDraft kinds", () => {
  test("every GraphQL kind maps back to the stored kind it comes from", () => {
    const kinds = [
      ["STRING", "string"],
      ["NUMBER", "number"],
      ["INTEGER", "integer"],
      ["BOOLEAN", "boolean"],
      ["ENUM", "enum"],
      ["STRING_LIST", "string[]"],
    ] as const;
    for (const [graphql, stored] of kinds) {
      expect(fieldDraft({ key: "k", kind: graphql }).kind).toBe(stored);
    }
  });
});

describe("drafts", () => {
  test("a field draft maps the GraphQL kind to the stored one", () => {
    const draft = fieldDraft({
      key: "amount",
      kind: "STRING_LIST",
      min: 1,
      values: [{ value: "a", label: [{ locale: "fr", text: "A" }] }],
    });
    expect(draft.kind).toBe("string[]");
    expect(draft.min).toBe(1);
    expect(draft.max).toBeUndefined();
    expect(draft.values).toEqual([
      { value: "a", label: [{ locale: "fr", text: "A" }] },
    ]);
  });

  test("a label not sent stays undefined, one sent is passed on", () => {
    expect(valueDraft({ value: "x" }).label).toBeUndefined();
    expect(valueDraft({ value: "x", label: null }).label).toBeUndefined();
    const label = [{ locale: "en", text: "X" }];
    expect(valueDraft({ value: "x", label }).label).toEqual(label);
    expect(fieldDraft({ key: "k", kind: "STRING", label }).label).toEqual(
      label,
    );
  });
});

describe("shapes", () => {
  const tenantId = new ObjectId();

  test("the audit target names the document and the tenant in hex", () => {
    const id = new ObjectId();
    expect(target("scope", tenantId, id)).toEqual({
      type: "scope",
      id: id.toHexString(),
      tenantId: tenantId.toHexString(),
    });
  });

  test("a scope without a resource shows a null resource id", () => {
    const scope = scopeDoc();
    expect(scopeShape(scope).resourceId).toBeNull();
  });

  test("a detail type shows its kinds in GraphQL names and no actions as []", () => {
    const doc = detailTypeDoc();
    const shown = detailTypeShape(doc);
    expect(shown.fields[0]?.kind).toBe("INTEGER");
    expect(shown.fields[0]?.min).toBeNull();
    expect(shown.actions).toEqual([]);
  });
});
