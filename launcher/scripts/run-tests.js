'use strict';
// scripts/run-tests.js — vitest 启动器（子进程方式，剥离 NODE_OPTIONS）
//
// 背景：部分环境（如 WorkBuddy）注入 NODE_OPTIONS=--require=*.cjs 拦截 fs/子进程
// 操作，会破坏 esbuild 原生服务的 socket 通信（EPIPE）。因此以子进程方式运行
// vitest，并剥离 NODE_OPTIONS：子进程（含 esbuild 服务与测试代码）继承干净环境，
// 保证原生 fs 删除等操作不被拦截（N37/快照回滚清理测试依赖真实删除）。
//
// 单仓 workspaces：vitest 可能提升到根 node_modules——用 require.resolve 上溯解析。
const { spawnSync } = require('child_process');
const path = require('path');

const vitestEntry = require.resolve('vitest/vitest.mjs', { paths: [path.join(__dirname, '..')] });
const env = { ...process.env };
delete env.NODE_OPTIONS;

const args = process.argv.slice(2);
const runArgs = args.length > 0 ? args : ['run'];
const r = spawnSync(process.execPath, ['--no-warnings', vitestEntry, ...runArgs], {
  stdio: 'inherit',
  env
});
process.exit(r.status === null ? 1 : r.status);
