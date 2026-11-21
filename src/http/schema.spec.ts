import { afterEach, expect, test } from "bun:test";
import { type DocumentNode, Kind } from "graphql";
import { consoleTypeDefs } from "../console/schema";
import { hostedTypeDefs } from "./schema";

const startCwd = process.cwd();
afterEach(() => process.chdir(startCwd));

const rootFields = (doc: DocumentNode): string[] =>
  doc.definitions.flatMap((definition) =>
    (definition.kind === Kind.OBJECT_TYPE_DEFINITION ||
      definition.kind === Kind.OBJECT_TYPE_EXTENSION) &&
    (definition.name.value === "Query" || definition.name.value === "Mutation")
      ? (definition.fields ?? []).map(
          (field) => `${definition.name.value}.${field.name.value}`,
        )
      : [],
  );

test("the hosted SDL holds no console root, whatever the cwd", () => {
  const hosted = rootFields(hostedTypeDefs());
  const consoleOnly = rootFields(consoleTypeDefs).filter(
    (field) => !hosted.includes(field),
  );
  expect(consoleOnly.length).toBeGreaterThan(0);
  process.chdir("/usr");
  const fromElsewhere = rootFields(hostedTypeDefs());
  expect(fromElsewhere.filter((field) => consoleOnly.includes(field))).toEqual(
    [],
  );
  expect([...fromElsewhere].sort()).toEqual([...hosted].sort());
});

test("a module SDL named like a skipped extension is loaded", () => {
  const names = hostedTypeDefs().definitions.flatMap((definition) =>
    definition.kind === Kind.OBJECT_TYPE_DEFINITION
      ? [definition.name.value]
      : [],
  );
  expect(names).toContain("ConsentDetail");
});
