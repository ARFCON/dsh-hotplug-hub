'use strict';
// test/helpers.js — 测试公共工具：假子进程、最小 core 构造
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createCore } = require('../app/create-core');
const { createProcPort } = require('../ports/proc');
/**
 * 构造假子进程（模拟 spawn 返回值）。
 * @param {object} [opts]
 * @param {number} [opts.pid]
 * @returns {object} EventEmitter 子进程
 */
function createFakeChild(opts = {}) {
  const child = new EventEmitter();
  child.pid = opts.pid || 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

/**
 * 隔离环境：覆盖 HOME/USERPROFILE/LOCALAPPDATA/ProgramFiles，防止测试
 * 中的 findHarness/findDshCli 探测或执行真实 dsh CLI（隔离红线）。
 * H-1 语义（v5）：DSH_HOME = .dsh 域目录本身 → home/.dsh（resolveDshRoot 契约）。
 * @param {string} home 隔离 home 目录
 * @returns {object} 隔离 env
 */
function isolatedEnv(home) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.HOME = home;
  env.USERPROFILE = home;
  env.LOCALAPPDATA = home;
  env.ProgramFiles = home;
  env['ProgramFiles(x86)'] = home;
  env.PATH = home; // PATH 指向隔离目录，杜绝 where dsh.cmd 命中真实 dsh CLI
  env.DSH_HOME = path.join(home, '.dsh');
  return env;
}

/**
 * 构造使用指定 spawn 行为的 core（用于 launch 测试）。
 * @param {Function} spawnFn
 * @returns {object} core
 */
function coreWithSpawn(spawnFn) {
  return createCore({
    baseDir: path.join(__dirname, '..'),
    home: os.tmpdir(),
    env: isolatedEnv(os.tmpdir()),
    procPort: createProcPort({
      spawn: spawnFn,
      spawnSync: () => ({ status: 1, error: null, stderr: 'Error: EACCES: permission denied', stdout: '' })
    })
  });
}

/**
 * 创建临时目录。
 * @param {string} [prefix]
 * @returns {string}
 */
function tempDir(prefix = 'launcher-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { createFakeChild, coreWithSpawn, tempDir, isolatedEnv };
