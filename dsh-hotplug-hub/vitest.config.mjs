// vitest.config.mjs — 测试配置：全局注入 describe/it/expect，Node 环境
// 覆盖率范围：lib/core + gateway + index（client.js/typert.js 为 DSH 客户端 UI 胶水，
// 依赖宿主客户端运行时，不在单测覆盖口径内；vendored 副本归 shared-core 测试）
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'istanbul',
      include: ['lib/core/**/*.js', 'lib/gateway.js', 'lib/index.js'],
      reporter: ['text'],
      // §8.5：hotplug src/* 行 ≥80%（阶段 3 起算；CI 低于门槛失败）
      thresholds: {
        lines: 80,
        statements: 75,
        functions: 80,
        branches: 55,
      },
    },
  },
})
