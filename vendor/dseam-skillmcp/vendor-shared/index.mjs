/**
 * index.mjs — shared-core ESM 薄垫片（createRequire 再导出，零逻辑）。
 *
 * 导出集合必须与 index.js（CJS 全导出）一致——由单测
 * test/esm-shim.test.mjs 断言防漂移（铁律 B）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = require('./index.js')

export default mod

// ids
export const {
  validateId, normalizeAndAssert, validatePluginId, validatePluginName,
  validateVersion, validateSourcePath, validateSourceRepo, validateSourceRef,
  isValidSemverString, TRAVERSAL_VECTORS,
} = mod

// contracts/errors
export const {
  ERROR_CODES, EXIT_CODE_BY_PREFIX, exitCodeForCode, makeError, isDshError, isLauncherError,
} = mod

// contracts/constants
export const {
  PACK_ID_RE, PLUGIN_NAME_RE, EXACT_VERSION_RE, RESERVED_WIN_NAMES, GITHUB_MIRRORS,
  SCHEMA_VERSION, HOTPACK_VERSION, MAX_ID_LENGTH, MAX_PATCH_ID_LENGTH, MAX_SOURCE_PATH_LENGTH,
  RUNLOG_MAX_BYTES, LOCK_WAIT_MS, LOCK_STALE_MS, LOCK_POLL_MS, LOCK_REFRESH_MS,
  LAUNCH_ALIVE_CHECK_MS, LAUNCH_WAIT_TIMEOUT_MS, CRASH_LOOP_THRESHOLD, CRASH_LOOP_WINDOW_MS,
  DEFAULT_RETRY_BUDGET, STATE_FILE, RUN_LOG_FILE, PATCH_FILE, PROFILE_MANIFEST,
  SNAPSHOT_INLINE_MAX_BYTES, PROFILES_DIR, STORE_DIR, MEMORY_DIR, HOTPLUG_DIR, PATCH_LOCK_FILE,
  resolveDshRoot, dshRootPaths, defaultRoots,
} = mod

// contracts/schemas
export const {
  assemblySchema, stateSchema, cordisPatchSchema, runLineSchema, commandResultSchema, SCHEMAS,
  validateState, validateRunLine, validateCommandResult, validateAssemblyShape,
} = mod

// contracts/state-machine（R-v5-20：装饰函数已删除）
export const {
  STATES, TRANSITIONS, COMMAND_PIPELINES, GUARD_DESCRIPTIONS,
  transitionInfo, assertCommandPipeline,
} = mod

// profile/patch
export const {
  patchIdFor, buildPatchDocument, serializePatch, parsePatchYaml, validatePatchDocument,
} = mod

// profile/merge
export const {
  mergePatchFile, removePatchBlock, findPatchBlock, patchMarker, PATCH_MARKER_RE,
} = mod

// fs/path-safe
export const {
  isWithin, assertWithin, isWithinRealpath, assertWithinRealpath, resolveExistingAncestor,
  safeJoin, checkWindowsSafeName, CONTROL_CHAR_RE, TRAILING_DOT_OR_SPACE_RE,
} = mod

// fs/atomic
export const { writeFileAtomic } = mod

// fs/lock
export const {
  acquireLock, releaseLock, readToken, parseToken, formatToken, isStale, probePid, isDirectoryLock,
} = mod

// fs/snapshot
export const {
  createSnapshot, restoreSnapshot, snapshotDigest, cleanupResidue,
} = mod

// fs/tree-util（removePath 亦由 fs/snapshot 再导出，值同引用）
export const { hashBuffer, entryType, walkFiles, collectAll, removePath } = mod

// fs/runlog
export const { createRunLog, nextRunSeq, readLastSeq, RUNLOG_LOCK_FILE } = mod

// fs/utf8
export const { isValidUtf8 } = mod

// security/shell
export const { CMD_SPECIAL_RE, assertShellSafe, assertShellSafeUrl, SHELL_SAFE_LIST } = mod

// security/net
export const { httpsGetText, validateZipEntryPath, sanitizeChildEnv, CHILD_ENV_BLOCKLIST } = mod

// format/hotpack
export const { parseHotpack, parseLegacy, validateAssembly, dshpackToHotpack } = mod
