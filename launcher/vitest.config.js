'use strict';
// vitest.config.js — 测试配置：全局注入 describe/it/expect，Node 环境
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 15000,
    // 收尾超时：防止真实子进程测试残留 handle 拖住 teardown（FIX 批次实测）
    teardownTimeout: 5000,
    // 覆盖率：v8 provider（Node/V8 原生插桩）。
    // 说明：vitest 的 istanbul provider 无法插桩通过 CJS require() 加载的源码
    // （vitest-dev/vitest#6168，官方行为：Vite 不拦截 require()），launcher 为 CJS
    // 包且测试全部使用 require()，istanbul 收集恒为 0；v8 provider 由 V8 原生
    // 插桩所有实际加载的文件，是本仓库 CJS 代码的正确覆盖率口径。
    coverage: {
      provider: 'v8',
      include: ['app/**/*.js', 'contracts/**/*.js', 'domain/**/*.js', 'infra/**/*.js', 'cli/**/*.js', 'ports/**/*.js', 'index.js'],
      exclude: ['test/**', 'scripts/**'],
      reporter: ['text'],
      // §8.5 门槛：launcher 行 ≥85%、分支 ≥80%；CI 低于门槛失败。
      // （ports/* 与 cli/parser.js 实测 100%，由 ports-contract/format/cli-contract 测试锁定）
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 80,
        branches: 80
      }
    }
  }
});
