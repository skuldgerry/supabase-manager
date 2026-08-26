import { createHash, randomUUID } from "node:crypto";
import { getDatabaseContext } from "@/lib/db/manager";
import type { UserId } from "@/lib/domain";
import { decryptJson, encryptJson, getMasterKey, type EncryptedEnvelope } from "./encryption";

type FactorRow = {
  user_id: string;
  enabled: number;
  ciphertext_base64: string;
  nonce_base64: string;
  auth_tag_base64: string;
  associated_data: string;
};

const hashCode = (value: string) => createHash("sha256").update(value.toUpperCase().replace(/[^A-Z2-7]/g, "")).digest("hex");

export async function getMfaFactor(userId: UserId): Promise<{ enabled: boolean; secret: string } | null> {
  const row = getDatabaseContext().database.prepare("SELECT * FROM mfa_factors WHERE user_id = ?").get(userId) as FactorRow | undefined;
  if (!row) return null;
  const envelope: EncryptedEnvelope = { version: 1, algorithm: "aes-256-gcm", iv: row.nonce_base64, tag: row.auth_tag_base64, ciphertext: row.ciphertext_base64 };
  const value = decryptJson<{ secret: string }>(envelope, await getMasterKey(), row.associated_data);
  return { enabled: row.enabled === 1, secret: value.secret };
}

export async function beginMfaEnrollment(userId: UserId, secret: string): Promise<void> {
  const associatedData = `${userId}:totp`;
  const envelope = encryptJson({ secret }, await getMasterKey(), associatedData);
  const timestamp = new Date().toISOString();
  getDatabaseContext().database.prepare(`
    INSERT INTO mfa_factors (user_id, enabled, ciphertext_base64, nonce_base64, auth_tag_base64, associated_data, created_at, updated_at)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled = 0, ciphertext_base64 = excluded.ciphertext_base64,
      nonce_base64 = excluded.nonce_base64, auth_tag_base64 = excluded.auth_tag_base64,
      associated_data = excluded.associated_data, updated_at = excluded.updated_at
  `).run(userId, envelope.ciphertext, envelope.iv, envelope.tag, associatedData, timestamp, timestamp);
}

export function enableMfa(userId: UserId, codes: readonly string[]): void {
  const database = getDatabaseContext().database;
  const timestamp = new Date().toISOString();
  database.transaction(() => {
    database.prepare("UPDATE mfa_factors SET enabled = 1, updated_at = ? WHERE user_id = ?").run(timestamp, userId);
    database.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").run(userId);
    const insert = database.prepare("INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)");
    for (const code of codes) insert.run(randomUUID(), userId, hashCode(code), timestamp);
  })();
}

export function consumeRecoveryCode(userId: UserId, code: string): boolean {
  return getDatabaseContext().database.prepare("UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .run(new Date().toISOString(), userId, hashCode(code)).changes === 1;
}

export function disableMfa(userId: UserId): void {
  const database = getDatabaseContext().database;
  database.transaction(() => {
    database.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").run(userId);
    database.prepare("DELETE FROM mfa_factors WHERE user_id = ?").run(userId);
  })();
}
