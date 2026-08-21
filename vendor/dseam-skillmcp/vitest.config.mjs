// vitest.config.mjs — dseam-skillmcp 测试配置（node 环境）
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
