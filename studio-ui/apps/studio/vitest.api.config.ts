import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '.') } },
  test: {
    environment: 'node',
    include: [
      'tests/unit/edge-function-test-handler.test.ts',
      'tests/unit/pocketbase-migrate-handler.test.ts',
      'tests/unit/pocketbase-migration-http.test.ts',
      'tests/unit/pg-meta-crypto-compatibility.test.ts',
      'lib/api/edgeFunctions.test.ts',
      'lib/api/self-hosted/util.test.ts',
      'lib/api/self-hosted/constants.test.ts',
    ],
  },
})
