import { describe, expect, test } from "bun:test";
import { DEVICE_GRANT } from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { fieldOf } from "~/gql-field";
import { jsonOf } from "~/json";
import { deviceCodesBody } from "~/oauth-bodies";
import {
  APPROVE_DEVICE,
  DEVICE,
  gql,
  PAY,
  post,
  tokensBody,
  transfer,
  withDetails,
} from "~/rar";
import { useRarTenant } from "~/rar-tenant";

useRarTenant();

describe("the device flow", () => {
  test("the verification page shows the details, approval allows all, the token carries them", async () => {
    const asked = [transfer(10)];
    const response = await post(
      "/device_authorization",
      {
        client_id: "tv",
        scope: "read",
        resource: PAY,
        authorization_details: JSON.stringify(asked),
      },
      "tv",
    );
    expect(response.status).toBe(200);
    const codes = await jsonOf(response, deviceCodesBody);
    const view = await gql(DEVICE, { c: codes.user_code }, "fr");
    expect(view.errors).toBeUndefined();
    const shown = fieldOf(view, "oauthDeviceRequest", withDetails).details;
    expect(shown).toMatchObject([
      {
        type: "payment",
        title: "Paiement",
        description: "Initier des virements",
      },
    ]);
    expect(shown).toHaveLength(1);

    const approved = await gql(APPROVE_DEVICE, { c: codes.user_code });
    expect(approved.errors).toBeUndefined();
    const tokens = await post(
      "/token",
      {
        grant_type: DEVICE_GRANT,
        device_code: codes.device_code,
        client_id: "tv",
      },
      "tv",
    );
    expect(tokens.status).toBe(200);
    const body = await jsonOf(tokens, tokensBody);
    expect(body.authorization_details).toEqual(asked);
    expect(decodeJwt(body.access_token)["authorization_details"]).toEqual(
      asked,
    );
  });
});
