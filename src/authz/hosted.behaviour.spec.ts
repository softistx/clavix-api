import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildSchema,
  type GraphQLInputType,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql";
import { env } from "@/config/env";
import { issuerOf, PLATFORM_TENANT_SLUG } from "@/modules/tenants";
import { createTestApp } from "~/app";
import { clientHeaders } from "~/client-header";
import { gqlOf } from "~/gql";
import { hostedPolicy } from "./policy";

// The hosted rules checked against behaviour (like authz.guards.spec for the
// console): an anonymous call to every root field. A `signedIn` rule must be
// answered UNAUTHENTICATED; an `open` rule must never be, since a field that
// demands a session behind an `open` rule would be served by its resolver alone.

const schema = buildSchema(readFileSync("schema.graphql", "utf8"));

// A value each scalar of a required argument accepts, so the call reaches the rules.
const SCALARS: Record<string, unknown> = {
  ID: "x",
  String: "x",
  Boolean: true,
  Float: 1,
  Int: 1,
  EmailAddress: "ada@example.com",
  HexColorCode: "#112233",
  Date: "2026-01-01",
  DateTime: "2026-01-01T00:00:00Z",
  LocalTime: "10:00:00",
};

const sampleOf = (type: GraphQLInputType): unknown => {
  if (isNonNullType(type)) return sampleOf(type.ofType);
  if (isListType(type)) return [sampleOf(type.ofType)];
  const named = getNamedType(type);
  if (isEnumType(named)) return named.getValues()[0]?.name;
  if (isInputObjectType(named)) {
    return Object.fromEntries(
      Object.values(named.getFields())
        .filter((field) => isNonNullType(field.type))
        .map((field) => [field.name, sampleOf(field.type)]),
    );
  }
  if (!(named.name in SCALARS)) throw new Error(`no sample for ${named.name}`);
  return SCALARS[named.name];
};

type Kind = "query" | "mutation";

const documentOf = (kind: Kind, name: string) => {
  const root =
    kind === "query" ? schema.getQueryType() : schema.getMutationType();
  const field = root?.getFields()[name];
  if (field === undefined) throw new Error(`no ${kind} ${name}`);
  const args = field.args.filter((arg) => isNonNullType(arg.type));
  const declared = args.map((arg) => `$${arg.name}: ${arg.type}`).join(", ");
  const passed = args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const selection = isObjectType(getNamedType(field.type))
    ? " { __typename }"
    : "";
  const call = `${name}${passed === "" ? "" : `(${passed})`}${selection}`;
  return {
    query: `${kind}${declared === "" ? "" : ` (${declared})`} { ${call} }`,
    variables: Object.fromEntries(
      args.map((arg) => [arg.name, sampleOf(arg.type)]),
    ),
  };
};

const fields = Object.entries(hostedPolicy.graphql ?? {}).flatMap(
  ([type, entries]) =>
    Object.entries(entries).map(([name, entry]) => ({
      kind: type === "Query" ? ("query" as const) : ("mutation" as const),
      name,
      signedIn: entry.rule.authenticated === true,
    })),
);

const app = createTestApp();

// The platform tenant's host, which the migrations seed; "localhost" names no tenant.
const TENANT_HOST = issuerOf(PLATFORM_TENANT_SLUG, {
  scheme: env.CLAVIX_PUBLIC_SCHEME,
  domain: env.CLAVIX_DOMAIN,
  port: env.CLAVIX_PUBLIC_PORT,
});

const anonymous = async (kind: Kind, name: string, host = TENANT_HOST) => {
  const response = await app.request(`${host}/graphql`, {
    method: "POST",
    headers: { ...clientHeaders, "content-type": "application/json" },
    body: JSON.stringify(documentOf(kind, name)),
  });
  return await gqlOf(response);
};

test("the hosted schema has root fields to check", () => {
  expect(fields.length).toBeGreaterThan(30);
});

for (const field of fields) {
  test(`${field.kind} ${field.name} ${field.signedIn ? "refuses" : "does not refuse"} an anonymous call`, async () => {
    const body = await anonymous(field.kind, field.name);
    const codes = (body.errors ?? []).map((error) => error.extensions?.code);
    if (field.signedIn) {
      expect(codes).toEqual(["UNAUTHENTICATED"]);
    } else {
      expect(codes).not.toContain("UNAUTHENTICATED");
      expect(codes).not.toContain("FORBIDDEN");
    }
  });
}

// The session is read lazily: a host that names no tenant answers NOT_FOUND
// (janus's `auth`) to the fields that need the caller, and serves the open ones.
test("a host with no tenant answers a signedIn field NOT_FOUND and serves an open one", async () => {
  const refused = await anonymous("query", "myPasskeys", "http://localhost");
  expect(refused.errors?.map((error) => error.extensions?.code)).toEqual([
    "NOT_FOUND",
  ]);
  const served = await anonymous("query", "health", "http://localhost");
  expect(served.errors).toBeUndefined();
});
