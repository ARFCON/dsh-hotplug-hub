'use strict';
// infra/store.js — state.json 唯一状态源（原子写、schemaVersion、sha256 指纹）
//
// 审计修复：
//   - F：check/status 只读命令不写 state
//   - G：resolved 被真正消费；外部修正通过 mergeState 保留（N34 修复）
//   - N33：state 损坏时禁止覆盖，返回错误而非空骨架整体写回
// v5（M-28/H-14）：读路径经 shared schemas 校验（phase enum）；
// 旧 phase 不在新 STATES → 映射 IDLE 并记 migratedFrom（兼容性契约 §9）。
const crypto = require('crypto');
const path = require('path');
const { SCHEMA_VERSION } = require('../contracts/constants');
const { makeError } = require('../contracts/errors');
const { writeFileAtomic } = require('./atomic');
const { validateState, validateRunLine, validateCommandResult } = require('../contracts/schemas');
const stateMachine = require('../contracts/state-machine');

const VALID_PHASES = new Set(Object.keys(stateMachine.STATES));

// Windows 防病毒/过滤驱动可能瞬时占用刚重命名落盘的文件，readFileSync 抛以下
// 错误码属瞬态（EPERM/EACCES/EBUSY/EAGAIN/EINTR），应重试而非误判"state 损坏"。
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EINTR']);

function sleepSync(ms) {
  // 主线程同步睡眠（Atomics.wait 在 Node 主线程可用，与 fs/lock.js 同源语义）
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

/**
 * 有界重试读取文件（仅针对瞬态 IO 错误码；确定性失败立即抛出，绝不掩盖）。
 * @param {object} fsPort fs 端口
 * @param {string} file 文件路径
 * @param {string} [encoding] 编码（默认 utf8）
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts] 最大尝试次数（默认 5）
 * @param {number} [opts.baseDelayMs] 首次重试退避基数（默认 10ms，线性递增）
 * @returns {string|Buffer} 文件内容
 */
function readFileSyncRetry(fsPort, file, encoding, opts = {}) {
  const maxAttempts = opts.maxAttempts === undefined ? 5 : opts.maxAttempts;
  const baseDelayMs = opts.baseDelayMs === undefined ? 10 : opts.baseDelayMs;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return fsPort.readFileSync(file, encoding);
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_READ_CODES.has(e.code)) throw e;
      if (i < maxAttempts - 1) sleepSync(baseDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * 创建空 state。
 * @param {string} id
 * @returns {object}
 */
function createEmptyState(id) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    assemblySha256: null,
    phase: 'IDLE',
    resolved: { plugins: [], conflicts: [], pinnedAt: null },
    install: { status: 'missing', lastExit: null, nodeModules: false },
    launch: { lastExit: null, lastStart: null, retries: 0, pid: null },
    heal: { history: [], quarantined: [] },
    rollback: { snapshot: null, lastRollbackAt: null }
  };
}

/**
 * 读取 state（不存在返回 state:null；损坏/高版本返回错误）。
 * @param {object} fsPort
 * @param {string} stateFile
 * @returns {{ok: boolean, state?: object|null, error?: Error}}
 */
function readState(fsPort, stateFile) {
  if (!fsPort.existsSync(stateFile)) return { ok: true, state: null };
  let raw;
  try {
    raw = JSON.parse(readFileSyncRetry(fsPort, stateFile, 'utf8'));
  } catch (e) {
    return { ok: false, error: makeError('ERR_ENV_UNSUPPORTED', `state.json 损坏：${e.message}`, { cause: e }) };
  }
  const migrated = migrateState(raw);
  if (!migrated.ok) return migrated;
  // H-14（v5）：读路径 schema 校验（phase enum 等）
  const check = validateState(migrated.state);
  if (!check.ok) {
    return { ok: false, error: makeError('ERR_ENV_UNSUPPORTED', `state.json 不符合 schema：${check.errors.join('；')}`, { cause: raw }) };
  }
  return { ok: true, state: migrated.state };
}

/**
 * FIX-9：state 迁移——逐级升级到当前 schemaVersion；未知高版本明确拒绝。
 * C4 修复：版本通过后按 createEmptyState 默认值深合并缺失的顶层字段——
 * 此前 schemaVersion=1 但缺 launch/heal/install 的 state 原样透传，
 * 后续阶段访问 state.launch.retries / state.heal.history 抛 TypeError → FATAL。
 * @param {unknown} raw 读到的原始 state
 * @returns {{ok: boolean, state?: object, error?: Error}}
 */
function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: makeError('ERR_ENV_UNSUPPORTED', 'state.json 损坏：不是对象') };
  }
  const v = raw.schemaVersion;
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return { ok: false, error: makeError('ERR_ENV_UNSUPPORTED', `state.json schemaVersion 非法：${JSON.stringify(v)}`) };
  }
  if (v > SCHEMA_VERSION) {
    return {
      ok: false,
      error: makeError('ERR_ENV_UNSUPPORTED', `state schemaVersion ${v} 高于当前支持版本 ${SCHEMA_VERSION}，请升级 launcher`)
    };
  }
  // v <= SCHEMA_VERSION：升级并补齐缺失的顶层字段（保留已有值；缺失字段补默认）
  let next = raw;
  if (v < SCHEMA_VERSION) {
    next = { ...raw, schemaVersion: SCHEMA_VERSION };
  }
  const empty = createEmptyState(typeof next.id === 'string' ? next.id : 'unknown');
  const merged = { ...empty, ...next };
  // 兼容性契约 §9（v5）：旧 phase 不在新 STATES → 映射 IDLE 并记 migratedFrom
  if (typeof merged.phase === 'string' && !VALID_PHASES.has(merged.phase)) {
    merged.migratedFrom = merged.phase;
    merged.phase = stateMachine.STATES.IDLE;
  }
  if (!merged.resolved || typeof merged.resolved !== 'object') merged.resolved = empty.resolved;
  else merged.resolved = { ...empty.resolved, ...merged.resolved };
  if (!merged.install || typeof merged.install !== 'object') merged.install = empty.install;
  else merged.install = { ...empty.install, ...merged.install };
  if (!merged.launch || typeof merged.launch !== 'object') merged.launch = empty.launch;
  else merged.launch = { ...empty.launch, ...merged.launch };
  if (!merged.heal || typeof merged.heal !== 'object') merged.heal = empty.heal;
  if (!Array.isArray(merged.heal.history)) merged.heal.history = [];
  if (!Array.isArray(merged.heal.quarantined)) merged.heal.quarantined = [];
  if (!merged.rollback || typeof merged.rollback !== 'object') merged.rollback = empty.rollback;
  if (merged.assemblySha256 === undefined) merged.assemblySha256 = empty.assemblySha256;
  if (merged.phase === undefined) merged.phase = empty.phase;
  return { ok: true, state: merged };
}

/**
 * 原子写 state（QA 修复：写失败归状态域 exit=10，而非日志域）。
 * C4/C7 修复：剥离运行时标志 dirty 后再序列化（state.json 不得出现
 * schema 未定义的运行时字段）；state 文件以 0600 写入（含启动环境信息，POSIX 下
 * 不向同机其他用户暴露）。
 * @param {object} fsPort
 * @param {string} stateFile
 * @param {object} state
 * @returns {{ok: boolean, error?: Error}}
 */
function writeState(fsPort, stateFile, state) {
  const { dirty: _dirty, ...persistable } = state;
  const json = JSON.stringify(persistable, null, 2) + '\n';
  const r = writeFileAtomic(fsPort, stateFile, json, { errorCode: 'ERR_LOCK_ACQUIRE', mode: 0o600 });
  if (!r.ok) return r;
  return { ok: true };
}

/**
 * 计算文件 sha256。
 * @param {object} fsPort
 * @param {string} file
 * @returns {string|null}
 */
function computeFileSha256(fsPort, file) {
  try {
    if (!fsPort.existsSync(file)) return null;
    const buf = fsPort.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) {
    return null;
  }
}

/**
 * 合并外部修正到 state（保留 heal 历史与人工字段，N34 修复）。
 * 语义：patch 只允许更新 resolved/assemblySha256/phase/install/launch；
 * heal 历史与隔离列表、rollback 快照永不被外部修正覆盖（X2/N34）。
 * @param {object} base 现有 state
 * @param {object} patch 修正片段
 * @returns {object} 新 state
 */
function mergeState(base, patch) {
  const next = JSON.parse(JSON.stringify(base));
  if (!patch || typeof patch !== 'object') return next;
  const mergedResolved = { ...(next.resolved || {}), ...(patch.resolved || {}) };
  next.resolved = mergedResolved;
  // 永不覆盖 heal 历史 / 隔离列表 / 回滚快照
  if (patch.assemblySha256 !== undefined) next.assemblySha256 = patch.assemblySha256;
  if (patch.phase !== undefined) next.phase = patch.phase;
  if (patch.install !== undefined) next.install = { ...(next.install || {}), ...patch.install };
  if (patch.launch !== undefined) next.launch = { ...(next.launch || {}), ...patch.launch };
  return next;
}

/**
 * state 文件路径。
 * @param {string} storeRoot
 * @param {string} id
 * @returns {string}
 */
function stateFilePath(storeRoot, id) {
  return path.join(storeRoot, id, 'state.json');
}

module.exports = {
  createEmptyState,
  readState,
  writeState,
  computeFileSha256,
  mergeState,
  migrateState,
  stateFilePath
};
