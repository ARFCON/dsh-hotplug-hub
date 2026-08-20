'use strict';
// app/create-core.js — 依赖注入容器（Hexagonal 装配点）
//
// 所有副作用（fs/spawn/registry/dsh/clock）只能经端口注入；
// Domain 层纯函数零副作用；infra 层通过 core 访问端口。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { defaultRoots } = require('../contracts/constants');
const { createFsPort } = require('../ports/fs');
const { createProcPort } = require('../ports/proc');
const { createRegistryPort, createEmptyRegistryPort } = require('../ports/registry');
const { createDshPort } = require('../ports/dsh');
const { createNowPort, createSystemNowPort } = require('../ports/now');

// Domain（纯函数，零副作用）
const domain = {
  ids: require('../domain/ids'),
  assembly: require('../domain/assembly'),
  resolve: require('../domain/resolve'),
  conflicts: require('../domain/conflicts'),
  classify: require('../domain/classify'),
  patch: require('../domain/patch'),
  healplan: require('../domain/healplan'),
  manifest: require('../domain/manifest') // P3：装配点完整（与 stages.js 使用一致）
};

// Infra（副作用实现，经 core 端口访问）
const infra = {
  atomic: require('../infra/atomic'),
  lock: require('../infra/lock'),
  store: require('../infra/store'),
  snapshot: require('../infra/snapshot'),
  runlog: require('../infra/runlog'),
  install: require('../infra/install'),
  profile: require('../infra/profile'),
  harness: require('../infra/harness'),
  launch: require('../infra/launch'),
  monitor: require('../infra/monitor'),
  heal: require('../infra/heal'),
  dshCli: require('../infra/dsh-cli')
};

function nodeFsPort() {
  return createFsPort(fs);
}

function nodeProcPort() {
  return createProcPort({ spawn, spawnSync });
}

/**
 * 默认 dsh 端口：真实接线 dsh CLI 探测 + plugin add 通道（FIX-15）。
 * 共享 createCore 注入的 fs/proc 端口与 config（测试可注入 proc 观察调用）。
 * @param {object} base { ports, config }
 * @returns {object}
 */
function lazyDshPort(base) {
  const { ports, config } = base;
  return createDshPort({
    findHarness: (o) => infra.harness.findHarness({ ports, config }, o),
    verifyHarness: (file) => infra.harness.verifyHarness(ports.fs, file),
    pluginAdd: async (profile, name, version) => {
      try {
        const spec = version ? `${name}@${version}` : name;
        const cmd = infra.dshCli.pluginAddCommand({ ports: { fs: ports.fs }, config }, { profile, packageSpec: spec });
        if (!cmd.ok) return { ok: false, error: cmd.error };
        const r = ports.proc.spawnSync(cmd.bin, cmd.args, { cwd: config.home, stdio: 'pipe', encoding: 'utf8' });
        if (r.error || r.status !== 0) {
          const msg = (r.error && r.error.message) || (r.stderr || '').slice(0, 500) || 'dsh plugin add 失败';
          return { ok: false, error: new Error(msg) };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e };
      }
    },
    isInstalled: (profile, name) => ports.fs.existsSync(path.join(profile, 'node_modules', name))
  });
}

/**
 * 创建核心对象。
 * @param {object} [overrides]
 * @param {object} [overrides.fsPort] 文件系统端口
 * @param {object} [overrides.procPort] 子进程端口
 * @param {object} [overrides.registryPort] registry 端口
 * @param {object} [overrides.dshPort] dsh 端口
 * @param {object} [overrides.nowPort] 时钟端口
 * @param {object} [overrides.roots] 根目录
 * @param {string} [overrides.baseDir] 模块根目录（推导 roots）
 * @param {string} [overrides.home] 用户主目录（推导 roots）
 * @param {string} [overrides.platform] 平台（默认 process.platform）
 * @param {object} [overrides.env] 环境变量（默认 process.env）
 * @returns {object} core
 */
function createCore(overrides = {}) {
  const roots = overrides.roots || defaultRoots(overrides.baseDir, overrides.home);
  // 隔离红线（A2 修复）：roots 注入但 home 未注入时，从 storeRoot 反推隔离 home
  // （storeRoot = <home>/.dsh/hotplug-store），绝不静默回退真实 os.homedir()。
  // 这样「只注入 roots」的测试/调用方天然获得与 roots 一致的隔离 home。
  let home = overrides.home;
  if (home === undefined && roots && roots.storeRoot) {
    const derived = path.dirname(path.dirname(roots.storeRoot));
    if (path.basename(path.dirname(roots.storeRoot)) === '.dsh') home = derived;
  }
  if (home === undefined) home = os.homedir();
  const platform = overrides.platform || process.platform;
  const env = overrides.env || process.env;

  const ports = {
    fs: overrides.fsPort || nodeFsPort(),
    proc: overrides.procPort || nodeProcPort(),
    registry: overrides.registryPort || createEmptyRegistryPort(),
    now: overrides.nowPort || createSystemNowPort()
  };
  const config = { roots, platform, env, home };
  // dsh 端口：若调用方注入，直接用；否则默认端口共享上述注入端口（FIX-15 可观测）
  ports.dsh = overrides.dshPort || lazyDshPort({ ports, config });

  return { ports, config, domain, infra };
}

module.exports = { createCore };
