'use strict';
// vitest.config.js — 测试配置：全局注入 describe/it/expect，Node 环境
// 覆盖率：v8 provider（CJS require 加载的源码 istanbul 无法插桩，见 launcher 配置说明）；
// 门槛 §8.5：行 ≥90%（CI 低于门槛失败）。
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/*.test.js', 'test/*.test.mjs'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['index.js', 'index.mjs', 'ids.js', 'contracts/**/*.js', 'profile/**/*.js', 'fs/**/*.js', 'security/**/*.js', 'format/**/*.js'],
      exclude: ['test/**'],
      reporter: ['text'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 75
      }
    }
  }
});
