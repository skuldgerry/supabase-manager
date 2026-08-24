import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

export type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

function parseConfiguredKey(value: string): Buffer {
  const normalized = value.trim();
  const key = /^[a-f\d]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error("MANAGER_MASTER_KEY must decode to exactly 32 bytes");
  }

  return key;
}

async function loadOrCreateFileKey(dataDir: string): Promise<Buffer> {
  const keyPath = path.join(dataDir, "master.key");
  try {
    const stored = await readFile(keyPath, "utf8");
    return parseConfiguredKey(stored);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const temporaryPath = `${keyPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, key.toString("base64"), { mode: 0o600, flag: "wx" });

  try {
    await rename(temporaryPath, keyPath);
    await chmod(keyPath, 0o600);
    return key;
  } catch (error) {
    const existing = await readFile(keyPath, "utf8").catch(() => undefined);
    if (existing) return parseConfiguredKey(existing);
    throw error;
  }
}

export async function getMasterKey(): Promise<Buffer> {
  const config = getConfig();
  return config.masterKey
    ? parseConfiguredKey(config.masterKey)
    : loadOrCreateFileKey(config.dataDir);
}

export function encryptJson(value: unknown, key: Buffer, associatedData?: string): EncryptedEnvelope {
  if (key.length !== KEY_BYTES) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (associatedData) cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);

  return {
    version: ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJson<T>(envelope: EncryptedEnvelope, key: Buffer, associatedData?: string): T {
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted credential envelope");
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Invalid encrypted credential envelope");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
