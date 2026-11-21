import crypto from 'crypto-js'

import {
  ENCRYPTION_KEY,
  POSTGRES_DATABASE,
  POSTGRES_HOST,
  POSTGRES_PASSWORD,
  POSTGRES_PORT,
  POSTGRES_USER_READ_ONLY,
  POSTGRES_USER_READ_WRITE,
} from './constants'
import { IS_PLATFORM } from '@/lib/constants'

/**
 * Asserts that the current environment is self-hosted.
 */
export function assertSelfHosted() {
  if (IS_PLATFORM) {
    throw new Error('This function can only be called in self-hosted environments')
  }
}

export function encryptString(stringToEncrypt: string): string {
  // pg-meta decrypts this reversible OpenSSL/CryptoJS envelope with CRYPTO_KEY.
  // Preserve its wire format; it is not a password hash. Local CLI development
  // still uses SAMPLE_KEY, but production must supply an independent secret.
  if (
    process.env.NODE_ENV === 'production' &&
    ['', 'SAMPLE_KEY', 'your-encryption-key-32-chars-min'].includes(ENCRYPTION_KEY.trim())
  ) {
    throw new Error('Configure a private PG_META_CRYPTO_KEY matching pg-meta CRYPTO_KEY before using encrypted database connections')
  }
  return crypto.AES.encrypt(stringToEncrypt, ENCRYPTION_KEY).toString()
}

export function getConnectionString({ readOnly }: { readOnly: boolean }) {
  const postgresUser = readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE

  return `postgresql://${postgresUser}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}`
}
