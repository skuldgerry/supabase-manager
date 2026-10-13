import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '.') } },
  test: {
    environment: 'node',
    include: ['tests/unit/edge-function-test-handler.test.ts', 'lib/api/edgeFunctions.test.ts'],
  },
})
