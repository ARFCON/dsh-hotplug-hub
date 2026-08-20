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
    teardownTimeout: 5000
  }
});
