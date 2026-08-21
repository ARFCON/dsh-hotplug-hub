'use strict';
// app/create-core.js — 依赖注入容器（Hexagonal 装配点）
//
// 所有副作用（fs/spawn/registry/dsh/clock）只能经端口注入；
// Domain 层纯函数零副作用；infra 层通过 core 访问端口。
//
// H-1 修复（v5 阶段 1）：根域统一经 shared resolveDshRoot 解析——
// 优先级 DSH_HOTPLUG_ROOT > DSH_HOME > ~/.dsh；DSH_HOTPLUG_ROOT 设定时整个根域
// （store/profiles/home）落其下；删除 os.homedir() 静默回退。
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolveDshRoot, dshRootPaths } = require('../contracts/constants');
const { sanitizeChildEnv } = require('@dsh/shared-core/security/net');
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
        // M-2（安全审计）：dsh CLI 子进程 env 净化（全量剥离；dsh plugin add
        // 通道不依赖 NODE_OPTIONS 注入）
        const r = ports.proc.spawnSync(cmd.bin, cmd.args, { cwd: config.home, stdio: 'pipe', encoding: 'utf8', env: sanitizeChildEnv(config.env) });
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
 * 默认根域（H-1）：assembly/sandbox 落 baseDir（缺省 = launcher 模块上级目录；
 * CLI 传 DSH_HOTPLUG_ROOT 时即该根）；profiles/store 经 resolveDshRoot(env) 派生。
 * @param {object} overrides { baseDir, env }
 * @returns {object} roots
 */
function defaultRootsFromEnv(overrides, env) {
  const baseDir = overrides.baseDir || path.resolve(__dirname, '..');
  const root = resolveDshRoot(env);
  const paths = dshRootPaths(root);
  return {
    assemblyDir: path.join(baseDir, 'assembly'),
    sandboxRoot: path.join(baseDir, 'sandbox', '.sandbox'),
    profilesRoot: paths.profilesDir,
    storeRoot: paths.storeDir
  };
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
  const env = overrides.env || process.env;
  const roots = overrides.roots || defaultRootsFromEnv(overrides, env);
  // 隔离红线（A2 修复）：roots 注入但 home 未注入时，从 storeRoot 反推隔离 home
  // （storeRoot = <home>/.dsh/hotplug-store），绝不静默回退真实 os.homedir()。
  // H-1 修复：仍无法推导时经 resolveDshRoot(env)（DSH_HOTPLUG_ROOT/DSH_HOME 优先），
  // 缺省才是 ~/.dsh 语义——不存在"注入隔离 roots 却用真实 homedir"的路径。
  let home = overrides.home;
  if (home === undefined && roots && roots.storeRoot) {
    const derived = path.dirname(path.dirname(roots.storeRoot));
    if (path.basename(path.dirname(roots.storeRoot)) === '.dsh') home = derived;
  }
  if (home === undefined) home = resolveDshRoot(env).home;
  const platform = overrides.platform || process.platform;

  const ports = {
    fs: overrides.fsPort || nodeFsPort(),
    proc: overrides.procPort || nodeProcPort(),
    registry: overrides.registryPort || createEmptyRegistryPort(),
    now: overrides.nowPort || createSystemNowPort()
  };
  const config = { roots, platform, env, home };
  // M-2（安全审计）：子进程 env 净化在各自 spawn 点显式执行（launch/install/
  // dsh 端口/harness 探测），config.env 保持原始注入 env（根域解析与调用方
  // 可观测性不变）——避免"创建即快照"遮蔽调用方后续 env 变更。
  // dsh 端口：若调用方注入，直接用；否则默认端口共享上述注入端口（FIX-15 可观测）
  ports.dsh = overrides.dshPort || lazyDshPort({ ports, config });

  return { ports, config, domain, infra };
}

module.exports = { createCore };
