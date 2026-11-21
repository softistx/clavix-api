import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { detailTypeDoc, scopeDoc } from "~/resource-docs";
import {
  detailTypeShape,
  fieldDraft,
  localised,
  localisedOrKeep,
  scopeShape,
  target,
  valueDraft,
} from "./resources.utils";

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
