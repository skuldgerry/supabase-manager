import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpSecret, totpCode, verifyTotp } from "../../src/lib/security/totp";

test("TOTP follows the RFC 6238 SHA1 test vector and accepts a bounded clock window", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 59_000), "287082");
  assert.equal(verifyTotp(secret, "287082", 59_000), true);
  assert.equal(verifyTotp(secret, "287082", 89_000), true);
  assert.equal(verifyTotp(secret, "000000", 59_000), false);
});

test("generated TOTP secrets contain enough base32 entropy", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
});
