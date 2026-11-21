import { describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { z } from "zod";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { resourcesService } from "@/config/resources";
import { registerClient } from "@/modules/clients";
import { fieldOf } from "~/gql-field";
import { jsonOf } from "~/json";
import {
  approve,
  codeToken,
  findTenant,
  gql,
  introspect,
  PAY,
  pushed,
  REDIRECT,
  REQUEST,
  ready,
  row,
  SLUG,
  text,
  tokensBody,
  transfer,
  value,
  withDetails,
} from "~/rar";
import { useRarTenant } from "~/rar-tenant";

useRarTenant();

describe("authorization details through consent", () => {
  test("PAR with details, consent view, approval: the token answer, the JWT and introspection carry them", async () => {
    const asked = [transfer(10), transfer(20, { memo: "Deposit" })];
    const id = await pushed(asked);
    const view = await gql(REQUEST, { id });
    expect(view.errors).toBeUndefined();
    const request = fieldOf(
      view,
      "oauthRequest",
      z.object({
        authorizationDetails: z.string(),
        details: z.array(z.unknown()),
      }),
    );
    // Every detail reaches the hosted API, in words, none raw.
    expect(request.details).toHaveLength(2);
    expect(JSON.parse(request.authorizationDetails)).toHaveLength(2);

    const tokens = await jsonOf(await codeToken(await approve(id)), tokensBody);
    expect(tokens.authorization_details).toEqual(asked);
    expect(decodeJwt(tokens.access_token)["authorization_details"]).toEqual(
      asked,
    );
    const active = await introspect(tokens.access_token);
    expect(active["active"]).toBe(true);
    expect(active["authorization_details"]).toEqual(asked);
  });

  test("a request without details has an empty list", async () => {
    const id = await pushed(null);
    const view = await gql(REQUEST, { id });
    expect(view.errors).toBeUndefined();
    expect(view.data?.["oauthRequest"]).toMatchObject({
      authorizationDetails: null,
      details: [],
    });
  });

  test("the labels follow the viewer's language, then the other one", async () => {
    const id = await pushed([transfer(1500.5)]);
    const detailsIn = async (language?: string) => {
      const view = await gql(REQUEST, { id }, language);
      expect(view.errors).toBeUndefined();
      return fieldOf(view, "oauthRequest", withDetails).details;
    };
    const rows = (words: {
      initiate: string;
      amount: string;
      currency: string;
      urgent: string;
      memo: string;
    }) => [
      row("ACTIONS", [value({ text: words.initiate })]),
      row("FIELD", [value({ number: 1500.5 })], {
        key: "amount",
        label: words.amount,
      }),
      row("FIELD", [value({ text: "Euro" })], {
        key: "currency",
        label: words.currency,
      }),
      row("FIELD", [value({ boolean: true })], {
        key: "urgent",
        label: words.urgent,
      }),
      row("FIELD", [value({ text: "Rent" })], {
        key: "memo",
        label: words.memo,
      }),
    ];
    expect(await detailsIn("fr-CA,en;q=0.8")).toEqual([
      {
        type: "payment",
        title: "Paiement",
        description: "Initier des virements",
        rows: rows({
          initiate: "Initier",
          amount: "Montant",
          currency: "Devise",
          urgent: "Urgent",
          memo: "Motif",
        }),
      },
    ]);
    expect(await detailsIn("en-US")).toEqual([
      {
        type: "payment",
        title: "Payment",
        description: "Start transfers",
        rows: rows({
          initiate: "Initiate",
          amount: "Amount",
          currency: "Currency",
          urgent: "Urgent",
          memo: "Memo",
        }),
      },
    ]);
  });

  test("a type the tenant wrote no French for shows its English words", async () => {
    const tenant = await findTenant(SLUG);
    if (tenant === undefined) throw new Error("no tenant");
    const resource = await mongo.db.resources.findFirst({
      uri: PAY,
      tenantId: tenant._id,
    });
    if (resource === undefined) throw new Error("none");
    await resourcesService.createDetailType(
      tenant._id,
      resource._id.toHexString(),
      {
        type: "ledger",
        name: text("", "Ledger"),
        fields: [
          { key: "account", kind: "string", label: text("", "Account") },
        ],
      },
    );
    await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant, detailTypes: ready },
      {
        tenant: SLUG,
        name: "payer",
        clientId: "payer",
        redirectUris: [REDIRECT],
        type: "confidential",
        requirePar: true,
        detailTypes: ["payment", "ledger"],
      },
    );
    const id = await pushed([{ type: "ledger", account: "A-1" }]);
    const view = await gql(REQUEST, { id }, "fr");
    expect(fieldOf(view, "oauthRequest", withDetails).details).toEqual([
      {
        type: "ledger",
        title: "Ledger",
        description: "",
        rows: [
          row("FIELD", [value({ text: "A-1" })], {
            key: "account",
            label: "Account",
          }),
        ],
      },
    ]);
  });
});
