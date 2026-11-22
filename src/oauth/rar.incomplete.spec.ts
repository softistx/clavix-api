import { describe, expect, test } from "bun:test";
import { DEVICE_GRANT } from "@softistx/janus-oauth";
import { z } from "zod";
import { mongo } from "@/config/db";
import { oauthDb } from "@/config/oauth-db";
import { resourcesService } from "@/config/resources";
import { registerClient } from "@/modules/clients";
import type { GqlResult } from "~/gql";
import { fieldOf } from "~/gql-field";
import { jsonOf } from "~/json";
import { deviceCodesBody } from "~/oauth-bodies";
import {
  APPROVE,
  APPROVE_DEVICE,
  findTenant,
  gql,
  PAY,
  post,
  pushed,
  REDIRECT,
  ready,
  SLUG,
  secrets,
  text,
  withComplete,
} from "~/rar";
import { useRarTenant } from "~/rar-tenant";

useRarTenant();

describe("details the page cannot fully describe", () => {
  const DEVICE_VIEW = `query($c: String!) { oauthDeviceRequest(userCode: $c) { detailsComplete } }`;
  const VIEW = `query($id: ID!) { oauthRequest(id: $id) { detailsComplete details { type } } }`;
  const asked = { type: "gift", note: "Hello", tag: "a" };
  let giftId = "";
  const gifted = (type: string) => ({ ...asked, type });

  // A fresh "gift" type per test, so each one edits or deletes its own.
  async function createGift(type = "gift") {
    const tenant = await findTenant(SLUG);
    if (tenant === undefined) throw new Error("no tenant");
    const resource = await mongo.db.resources.findFirst({
      uri: PAY,
      tenantId: tenant._id,
    });
    if (resource === undefined) throw new Error("none");
    const created = await resourcesService.createDetailType(
      tenant._id,
      resource._id.toHexString(),
      {
        type,
        name: text("Cadeau", "Gift"),
        fields: [
          { key: "note", kind: "string", label: text("Note", "Note") },
          { key: "tag", kind: "string", label: text("Etiquette", "Tag") },
        ],
      },
    );
    giftId = created._id.toHexString();
    await registerClient(
      { now: () => new Date(), db: oauthDb, findTenant, detailTypes: ready },
      {
        tenant: SLUG,
        name: "gifter",
        clientId: "gifter",
        redirectUris: [REDIRECT],
        type: "confidential",
        requirePar: true,
        grants: ["authorization_code", DEVICE_GRANT],
        detailTypes: [type],
      },
    ).then((done) => {
      secrets["gifter"] = done.clientSecret ?? secrets["gifter"] ?? "";
    });
    return tenant._id;
  }
  const dropGift = (type: string) =>
    mongo.db.detailTypes.raw.deleteMany({ type });

  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions?.code;
  const deviceCode = async (details: unknown) => {
    const response = await post(
      "/device_authorization",
      {
        client_id: "gifter",
        scope: "read",
        resource: PAY,
        authorization_details: JSON.stringify(details),
      },
      "gifter",
    );
    expect(response.status).toBe(200);
    return jsonOf(response, deviceCodesBody);
  };

  test("unchanged: complete and approved", async () => {
    await createGift("gift-ok");
    const id = await pushed([gifted("gift-ok")], { client: "gifter" });
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", z.unknown())).toEqual({
      detailsComplete: true,
      details: [{ type: "gift-ok" }],
    });
    const approved = await gql(APPROVE, { id });
    expect(approved.errors).toBeUndefined();
    const codes = await deviceCode([gifted("gift-ok")]);
    const seen = await gql(DEVICE_VIEW, { c: codes.user_code });
    expect(
      fieldOf(seen, "oauthDeviceRequest", withComplete).detailsComplete,
    ).toBe(true);
    expect((await gql(APPROVE_DEVICE, { c: codes.user_code })).errors).toBe(
      undefined,
    );
    await dropGift("gift-ok");
  });

  test("a selection of details is refused in both flows (D4: all or nothing), the request stays pending", async () => {
    await createGift("gift-sel");
    const id = await pushed([gifted("gift-sel")], { client: "gifter" });
    const codes = await deviceCode([gifted("gift-sel")]);
    const selection = JSON.stringify([gifted("gift-sel")]);
    const refused = await gql(
      `mutation($id: ID!, $d: String) { approveOAuthRequest(id: $id, authorizationDetails: $d) { redirectTo } }`,
      { id, d: selection },
    );
    expect(codeOf(refused)).toBe("BAD_USER_INPUT");
    expect(refused.errors?.[0]?.message).toBe("invalid_authorization_details");
    const device = await gql(
      `mutation($c: String!, $d: String) { approveOAuthDeviceRequest(userCode: $c, authorizationDetails: $d) }`,
      { c: codes.user_code, d: selection },
    );
    expect(codeOf(device)).toBe("BAD_USER_INPUT");
    expect(device.errors?.[0]?.message).toBe("invalid_authorization_details");
    // Still pending: approving without a selection works.
    expect((await gql(APPROVE, { id })).errors).toBeUndefined();
    await dropGift("gift-sel");
  });

  test("a field removed between the PAR and the consent: not complete, approval refused, request still pending", async () => {
    const tenantId = await createGift("gift-edit");
    const id = await pushed([gifted("gift-edit")], { client: "gifter" });
    const codes = await deviceCode([gifted("gift-edit")]);
    await resourcesService.updateDetailType(tenantId, giftId, {
      fields: [{ key: "note", kind: "string", label: text("Note", "Note") }],
    });
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", withComplete).detailsComplete).toBe(
      false,
    );
    const refused = await gql(APPROVE, { id });
    expect(codeOf(refused)).toBe("BAD_USER_INPUT");
    expect(refused.errors?.[0]?.message).toBe("invalid_authorization_details");
    const seen = await gql(DEVICE_VIEW, { c: codes.user_code });
    expect(
      fieldOf(seen, "oauthDeviceRequest", withComplete).detailsComplete,
    ).toBe(false);
    const device = await gql(APPROVE_DEVICE, { c: codes.user_code });
    expect(device.errors?.[0]?.message).toBe("invalid_authorization_details");
    // Nothing was approved: denying still works.
    const denied = await gql(
      `mutation($id: ID!) { denyOAuthRequest(id: $id) { redirectTo } }`,
      { id },
    );
    expect(denied.errors).toBeUndefined();
    await dropGift("gift-edit");
  });

  test("a type deleted between the PAR and the consent: not complete, approval refused", async () => {
    await createGift("gift-gone");
    const id = await pushed([gifted("gift-gone")], { client: "gifter" });
    const codes = await deviceCode([gifted("gift-gone")]);
    await dropGift("gift-gone");
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", withComplete).detailsComplete).toBe(
      false,
    );
    expect(codeOf(await gql(APPROVE, { id }))).toBe("BAD_USER_INPUT");
    expect(codeOf(await gql(APPROVE_DEVICE, { c: codes.user_code }))).toBe(
      "BAD_USER_INPUT",
    );
  });

  test("a request without details is complete", async () => {
    const id = await pushed(null);
    const view = await gql(VIEW, { id });
    expect(fieldOf(view, "oauthRequest", withComplete).detailsComplete).toBe(
      true,
    );
  });
});
