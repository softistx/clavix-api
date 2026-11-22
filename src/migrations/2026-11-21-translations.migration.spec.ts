import { beforeEach, describe, expect, test } from "bun:test";
import { migrate, rollback } from "@softistx/mongo/migrations";
import { type Db, ObjectId } from "mongodb";
import { freshMigrationDb } from "~/migrations";
import { id, translationsMigration } from "./2026-11-21-translations.migration";

let db: Db;
const tenantId = new ObjectId();
const stamp = new Date(0);
const BYPASS = { bypassDocumentValidation: true } as const;

const legacyScope = (name: string, description: unknown) =>
  db.collection("scopes").insertOne(
    {
      tenantId,
      name,
      description,
      resourceId: null,
      claims: [],
      createdAt: stamp,
      updatedAt: stamp,
    },
    BYPASS,
  );

const legacyType = () =>
  db.collection("detailTypes").insertOne(
    {
      tenantId,
      resourceId: new ObjectId(),
      type: "pay",
      name: { fr: "Paiement", en: "Payment" },
      description: { fr: "", en: "A payment" },
      fields: [
        {
          key: "mode",
          kind: "enum",
          label: { fr: "Mode", en: "" },
          required: false,
          values: [{ value: "card", label: { fr: "Carte", en: "Card" } }],
        },
      ],
      actions: [{ value: "send", label: { fr: "", en: "Send" } }],
      createdAt: stamp,
      updatedAt: stamp,
    },
    BYPASS,
  );

const scopeOf = async (name: string) =>
  (await db.collection("scopes").findOne({ name }))?.["description"];

beforeEach(async () => {
  db = await freshMigrationDb();
});

describe(id, () => {
  test("up turns { fr, en } into a list, English first, blank languages left out", async () => {
    await legacyScope("both", { fr: "Lire", en: "Read" });
    await legacyScope("french", { fr: "Écrire", en: "" });
    await legacyScope("none", { fr: "", en: "" });
    await legacyType();
    await migrate(db, [translationsMigration]);
    expect(await scopeOf("both")).toEqual([
      { locale: "en", text: "Read" },
      { locale: "fr", text: "Lire" },
    ]);
    expect(await scopeOf("french")).toEqual([{ locale: "fr", text: "Écrire" }]);
    expect(await scopeOf("none")).toEqual([]);
    expect(await db.collection("detailTypes").findOne({})).toMatchObject({
      name: [
        { locale: "en", text: "Payment" },
        { locale: "fr", text: "Paiement" },
      ],
      description: [{ locale: "en", text: "A payment" }],
      fields: [
        {
          key: "mode",
          label: [{ locale: "fr", text: "Mode" }],
          values: [
            {
              value: "card",
              label: [
                { locale: "en", text: "Card" },
                { locale: "fr", text: "Carte" },
              ],
            },
          ],
        },
      ],
      actions: [{ value: "send", label: [{ locale: "en", text: "Send" }] }],
    });
  });

  test("a text that is already a list is left alone, and a second run changes nothing", async () => {
    const list = [{ locale: "de", text: "Lesen" }];
    await legacyScope("german", list);
    await legacyScope("old", { fr: "Lire", en: "" });
    await migrate(db, [translationsMigration]);
    await db
      .collection<{ _id: string }>("nxgt_migrations")
      .deleteMany({ _id: id });
    await migrate(db, [translationsMigration]);
    expect(await scopeOf("german")).toEqual(list);
    expect(await scopeOf("old")).toEqual([{ locale: "fr", text: "Lire" }]);
  });

  test("down puts fr and en back; other locales are lost", async () => {
    await legacyScope("mixed", { fr: "Lire", en: "Read" });
    await legacyType();
    await migrate(db, [translationsMigration]);
    await db.collection("scopes").updateOne(
      { name: "mixed" },
      {
        $set: {
          description: [
            { locale: "en", text: "Read" },
            { locale: "fr", text: "Lire" },
            { locale: "de", text: "Lesen" },
          ],
        },
      },
    );
    await rollback(db, [translationsMigration]);
    expect(await scopeOf("mixed")).toEqual({ fr: "Lire", en: "Read" });
    expect(await db.collection("detailTypes").findOne({})).toMatchObject({
      name: { fr: "Paiement", en: "Payment" },
      fields: [{ label: { fr: "Mode", en: "" } }],
      actions: [{ label: { fr: "", en: "Send" } }],
    });
  });
});
