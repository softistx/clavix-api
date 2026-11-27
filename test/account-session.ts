import { env } from "@/config/env";
import { oauthDb } from "@/config/oauth-db";
import { janusIssuers } from "@/config/users";
import { issuerOf } from "@/modules/tenants";
import { SESSION_COOKIE } from "@/modules/users";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { type GqlResult, gqlOf } from "~/gql";

const origin = {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
} as const;

/** The host of a tenant's hosted pages, as the specs reach it. */
export const hostOf = (slug: string) => issuerOf(slug, origin);

export interface Answer {
  status: number;
  headers: Headers;
  data: Record<string, unknown> | null;
  errors?: GqlResult["errors"];
}

export const app = createTestApp();

/** One GraphQL call on a tenant's host, with an optional session cookie. */
export async function gql(
  slug: string,
  query: string,
  variables: Record<string, unknown> = {},
  cookie?: string,
): Promise<Answer> {
  const response = await app.request(`${hostOf(slug)}/graphql`, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.9",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await gqlOf(response);
  return {
    status: response.status,
    headers: response.headers,
    data: body.data ?? null,
    ...(body.errors === undefined ? {} : { errors: body.errors }),
  };
}

export const codeOf = (answer: Answer) =>
  answer.errors?.[0]?.extensions?.["code"];

export const janusOf = async (slug: string) => {
  const auth = await janusIssuers.forRequest(
    new Request(`${hostOf(slug)}/graphql`),
  );
  if (auth === null) throw new Error(`no janus for ${slug}`);
  return auth;
};

let counter = 0;
/** A new user of the tenant with a session just proved; `cookie` carries it. */
export async function signedIn(slug: string, email?: string) {
  counter += 1;
  const auth = await janusOf(slug);
  const user = await auth.create({
    email: email ?? `acct${counter}@example.test`,
  });
  const result = await auth.signInProven(user);
  if (result.status !== "signedIn") throw new Error("no session");
  return { user, auth, cookie: `${SESSION_COOKIE}=${result.token}` };
}

/** Makes the user's sessions older than the ten-minute proof the e-mail change asks for. */
export const ageSessions = (userId: string) =>
  oauthDb
    .collection("partitionedSessions")
    .updateMany(
      { userId },
      { $set: { authenticatedAt: new Date(Date.now() - 11 * 60_000) } },
    );

/** Empties the janus collections the specs filled. */
export async function clearJanus() {
  for (const name of [
    "partitionedUsers",
    "partitionedSessions",
    "partitionedTokens",
  ]) {
    await oauthDb.collection(name).deleteMany({});
  }
}
