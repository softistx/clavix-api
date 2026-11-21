import { expect, test } from "bun:test";
import { createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { instance } from "~/narrow";
import { sealedSecretSchema } from "./sign-in-methods.schema";
import { createSecretBox, secretContext } from "./sign-in-methods.secrets";

const master = randomBytes(32);
const box = createSecretBox(master);
const context = secretContext("65f0000000000000000000aa", "google");

test("the envelope is { v, kid, iv, ct } and holds no plaintext", () => {
  const sealed = box.seal("s3cret-value", context);
  expect(Object.keys(sealed).sort()).toEqual(["ct", "iv", "kid", "v"]);
  expect(sealedSecretSchema.parse(sealed)).toEqual(sealed);
  expect(sealed.v).toBe(1);
  expect(sealed.kid).toBe(box.kid);
  expect(Buffer.from(sealed.iv, "base64url")).toHaveLength(12);
  expect(JSON.stringify(sealed)).not.toContain("s3cret-value");
  expect(box.open(sealed, context)).toBe("s3cret-value");
});

test("two seals of one secret differ", () => {
  expect(box.seal("same", context)).not.toEqual(box.seal("same", context));
});

test("the key is the HKDF-SHA256 subkey labelled social-secrets, not the master key", () => {
  const sealed = box.seal("s3cret-value", context);
  const bytes = Buffer.from(sealed.ct, "base64url");
  const open = (key: Uint8Array) => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(sealed.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`v1:${sealed.kid}:${context}`));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  };
  const subkey = new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(0), "social-secrets", 32),
  );
  expect(open(subkey)).toBe("s3cret-value");
  expect(() => open(master)).toThrow();
});

test("the kid names the master key without being part of it", () => {
  expect(createSecretBox(master).kid).toBe(box.kid);
  expect(createSecretBox(randomBytes(32)).kid).not.toBe(box.kid);
  expect(master.toString("base64url")).not.toContain(box.kid);
});

test("another tenant, provider, key, version or a changed byte does not open", () => {
  const sealed = box.seal("s3cret-value", context);
  const refused = [
    () => box.open(sealed, secretContext("65f0000000000000000000bb", "google")),
    () => box.open(sealed, secretContext("65f0000000000000000000aa", "github")),
    () => createSecretBox(randomBytes(32)).open(sealed, context),
    () => box.open(Object.assign({ ...sealed }, { v: 2 }), context),
    () => box.open({ ...sealed, ct: `A${sealed.ct.slice(1)}x` }, context),
    () => box.open({ ...sealed, ct: "" }, context),
  ];
  for (const attempt of refused) {
    let error: unknown;
    try {
      attempt();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(instance(error, Error).message)).not.toContain(
      "s3cret-value",
    );
  }
});

test("a keyring: the first key seals, every key opens, a stranger does not", () => {
  const old = randomBytes(32);
  const next = randomBytes(32);
  const sealedOld = createSecretBox(old).seal("old-secret", context);

  const ring = createSecretBox([next, old]);
  expect(ring.kid).toBe(createSecretBox(next).kid);
  expect(ring.opens(sealedOld.kid)).toBe(true);
  expect(ring.opens("AAAAAAAAAAA")).toBe(false);
  expect(ring.open(sealedOld, context)).toBe("old-secret");

  const sealedNew = ring.seal("new-secret", context);
  expect(sealedNew.kid).toBe(ring.kid);
  expect(createSecretBox(next).open(sealedNew, context)).toBe("new-secret");
  expect(() => createSecretBox(next).open(sealedOld, context)).toThrow(
    "Sealed under another key",
  );
  // An empty keyring is one the types forbid: it reaches the function untyped.
  // @ts-expect-error an empty keyring is not a `NonEmptyKeys`
  expect(() => createSecretBox([])).toThrow(TypeError);
});
