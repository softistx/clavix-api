import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { StoredDetailTypeDoc, StoredScopeDoc } from "./resources.types";
import {
  detailTypeShape,
  fieldDraft,
  localised,
  localisedOrKeep,
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

describe("localised", () => {
  test("a language not sent stays undefined", () => {
    expect(localised({ fr: "a", en: null })).toEqual({
      fr: "a",
      en: undefined,
    });
    expect(localised({})).toEqual({ fr: undefined, en: undefined });
  });

  test("localisedOrKeep leaves a text not sent at all", () => {
    expect(localisedOrKeep(null)).toBeUndefined();
    expect(localisedOrKeep(undefined)).toBeUndefined();
    expect(localisedOrKeep({ en: "b" })).toEqual({
      fr: undefined,
      en: "b",
    });
  });
});

describe("drafts", () => {
  test("a field draft maps the GraphQL kind to the stored one", () => {
    const draft = fieldDraft({
      key: "amount",
      kind: "STRING_LIST",
      min: 1,
      values: [{ value: "a", label: { fr: "A" } }],
    });
    expect(draft.kind).toBe("string[]");
    expect(draft.min).toBe(1);
    expect(draft.max).toBeUndefined();
    expect(draft.values).toEqual([
      { value: "a", label: { fr: "A", en: undefined } },
    ]);
  });

  test("a value draft without a label has empty languages", () => {
    expect(valueDraft({ value: "x" }).label).toEqual({
      fr: undefined,
      en: undefined,
    });
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
    const scope = {
      _id: new ObjectId(),
      name: "read",
      description: { fr: "", en: "" },
      resourceId: null,
      claims: [],
    } as unknown as StoredScopeDoc;
    expect(scopeShape(scope).resourceId).toBeNull();
  });

  test("a detail type shows its kinds in GraphQL names and no actions as []", () => {
    const doc = {
      _id: new ObjectId(),
      resourceId: new ObjectId(),
      type: "pay",
      name: { fr: "", en: "" },
      description: { fr: "", en: "" },
      fields: [{ key: "n", kind: "integer", label: {}, required: true }],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as unknown as StoredDetailTypeDoc;
    const shown = detailTypeShape(doc);
    expect(shown.fields[0]?.kind).toBe("INTEGER");
    expect(shown.fields[0]?.min).toBeNull();
    expect(shown.actions).toEqual([]);
  });
});
