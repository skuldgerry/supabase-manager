import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../../src/lib/security/password";

test("passwords are stored with Argon2id and verified", async () => {
  const digest = await hashPassword("a-valid-password-123");
  assert.match(digest, /^\$argon2id\$/);
  assert.equal(await verifyPassword(digest, "a-valid-password-123"), true);
  assert.equal(await verifyPassword(digest, "incorrect-password"), false);
});
