import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptJson, encryptJson } from "../../src/lib/security/encryption";

test("credential envelopes round-trip without exposing plaintext", () => {
  const key = randomBytes(32);
  const value = { serviceRoleKey: "secret-value", postgresPassword: "database-value" };
  const envelope = encryptJson(value, key);

  assert.equal(JSON.stringify(envelope).includes("secret-value"), false);
  assert.deepEqual(decryptJson(envelope, key), value);
});

test("credential envelopes reject the wrong key", () => {
  const envelope = encryptJson({ secret: "value" }, randomBytes(32));
  assert.throws(() => decryptJson(envelope, randomBytes(32)));
});

test("credential envelopes are bound to associated project data", () => {
  const key = randomBytes(32);
  const envelope = encryptJson({ secret: "bound" }, key, "project-a:credentials");
  assert.deepEqual(decryptJson(envelope, key, "project-a:credentials"), { secret: "bound" });
  assert.throws(() => decryptJson(envelope, key, "project-b:credentials"));
});
