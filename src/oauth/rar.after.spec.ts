import { describe, expect, test } from "bun:test";
import { TOKEN_EXCHANGE_GRANT } from "@softistx/janus-oauth";
import { decodeJwt } from "jose";
import { errorBody, jsonOf } from "~/json";
import {
  consented,
  introspect,
  OTHER,
  PAY,
  post,
  tokensBody,
  transfer,
} from "~/rar";
import { useRarTenant } from "~/rar-tenant";

useRarTenant();

describe("what happens to the details after consent", () => {
  test("a refresh narrows them, never widens", async () => {
    const first = transfer(10);
    const second = transfer(20, { memo: "Deposit" });
    const tokens = await consented([first, second], "read");
    const refreshed = await post(
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        resource: PAY,
        authorization_details: JSON.stringify([first]),
      },
      "payer",
    );
    expect(refreshed.status).toBe(200);
    const narrowed = await jsonOf(refreshed, tokensBody);
    expect(narrowed.authorization_details).toEqual([first]);
    expect(decodeJwt(narrowed.access_token)["authorization_details"]).toEqual([
      first,
    ]);

    // The grant keeps what the user allowed: a detail they never saw is refused.
    const widened = await post(
      "/token",
      {
        grant_type: "refresh_token",
        refresh_token: narrowed.refresh_token ?? "",
        resource: PAY,
        authorization_details: JSON.stringify([transfer(99)]),
      },
      "payer",
    );
    expect(widened.status).toBe(400);
    expect((await jsonOf(widened, errorBody)).error).toBe(
      "invalid_authorization_details",
    );
  });

  test("a re-consent that leaves a detail out revokes the grant's tokens, one that asks for none revokes nothing", async () => {
    const kept = transfer(10);
    const before = await consented([kept, transfer(20, { memo: "Deposit" })]);
    expect((await introspect(before.access_token))["active"]).toBe(true);
    // No detail: the standing grant stays (janus-oauth, "Consent").
    const plain = await consented(null);
    expect(plain.authorization_details).toBeUndefined();
    expect((await introspect(before.access_token))["active"]).toBe(true);
    // The grant's details are replaced; leaving one out revokes its tokens.
    const after = await consented([kept]);
    expect(after.authorization_details).toEqual([kept]);
    expect((await introspect(before.access_token))["active"]).toBe(false);
    expect((await introspect(after.access_token))["active"]).toBe(true);
  });

  test("a token exchange inherits the details on the same resource and drops them on another", async () => {
    const asked = [transfer(10)];
    const { access_token } = await consented(asked);
    const exchange = (resource: string) =>
      post(
        "/token",
        {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: access_token,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource,
        },
        "svc",
      );
    const same = await exchange(PAY);
    expect(same.status).toBe(200);
    expect(
      decodeJwt((await jsonOf(same, tokensBody)).access_token)[
        "authorization_details"
      ],
    ).toEqual(asked);
    const other = await exchange(OTHER);
    expect(other.status).toBe(200);
    expect(
      decodeJwt((await jsonOf(other, tokensBody)).access_token)[
        "authorization_details"
      ],
    ).toBeUndefined();
  });
});
