import CryptoJS from 'crypto-js'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/constants', () => ({ IS_PLATFORM: false, PG_META_URL: 'http://meta.test' }))
vi.mock('../../../../lib/api/self-hosted/project-registry', () => ({ getProject: () => null }))

const implementations = [
  ['Studio', () => import('../../lib/api/self-hosted/util')],
  ['legacy Studio', () => import('../../../../lib/api/self-hosted/util')],
] as const

describe.each(implementations)('%s pg-meta encryption', (_name, load) => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('NODE_ENV', 'production') })
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it.each([undefined, '', ' ', 'SAMPLE_KEY', ' SAMPLE_KEY ', 'your-encryption-key-32-chars-min'])('rejects a missing or example production key (%s)', async (key) => {
    vi.stubEnv('PG_META_CRYPTO_KEY', key)
    const { encryptString } = await load()
    const encrypt = vi.spyOn(CryptoJS.AES, 'encrypt')
    expect(() => encryptString('postgresql://fixture:fixture-password@db:5432/fixture')).toThrow('Configure a private PG_META_CRYPTO_KEY')
    expect(encrypt).not.toHaveBeenCalled()
  })

  it('uses a random salt and round-trips through the CryptoJS wire contract', async () => {
    const key = randomBytes(24).toString('base64')
    vi.stubEnv('PG_META_CRYPTO_KEY', key)
    const { encryptString } = await load()
    const connection = 'postgresql://fixture:password%3A%40%23@db:5432/fixture?application_name=Studio'
    const first = encryptString(connection)
    const second = encryptString(connection)
    expect(first).not.toBe(second)
    expect(Buffer.from(first, 'base64').subarray(0, 8).toString()).toBe('Salted__')
    // Unit-level check of the receiver's CryptoJS contract; service acceptance is separate.
    expect(CryptoJS.AES.decrypt(first, key).toString(CryptoJS.enc.Utf8).trim()).toBe(connection)
    expect(CryptoJS.AES.decrypt(second, key).toString(CryptoJS.enc.Utf8).trim()).toBe(connection)
    expect(first).not.toContain(connection)
  })

  it('preserves a non-default legacy key without trimming or silently rotating it', async () => {
    const key = ' older-custom-key '
    vi.stubEnv('PG_META_CRYPTO_KEY', key)
    const { encryptString } = await load()
    const connection = 'postgresql://fixture:fixture-password@db:5432/fixture'
    expect(CryptoJS.AES.decrypt(encryptString(connection), key).toString(CryptoJS.enc.Utf8)).toBe(connection)
  })

  it('preserves the official local CLI development default', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('PG_META_CRYPTO_KEY', undefined)
    const { encryptString } = await load()
    const connection = 'postgresql://fixture:fixture-password@db:5432/fixture'
    expect(CryptoJS.AES.decrypt(encryptString(connection), 'SAMPLE_KEY').toString(CryptoJS.enc.Utf8)).toBe(connection)
  })
})
