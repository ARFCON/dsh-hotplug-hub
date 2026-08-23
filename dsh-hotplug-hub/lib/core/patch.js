/**
 * lib/core/patch.js — profile 挂载：patch 块 / bundles / link（v5 阶段 3 拆出 + 阶段 4 契约化）
 *
 * 阶段 4（R-v5-12 / H-16）：cordis.patch.yml 写路径统一为 vendor-shared profile/merge
 * 分节保留合并 + 四写者锁（<profile>/.dsh-patch.lock，CONTRACT.md §5）：
 *   - marker：`## hotplug:<packId>`（读兼容旧 `# hotplug:<packId>` 单 # 与
 *     旧内联 `- insert:  # hotplug:<packId>` 形态——移除时按 marker 匹配）；
 *   - 其它块/注释原样保留，永不整文件覆盖；
 *   - patch id 算法统一到 vendor-shared patchIdFor（清洗 + 64 上限 + 哈希后缀；
 *     旧 id 不重生成，删除按 marker 匹配，见 CONTRACT.md §9 迁移规则）。
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, copyFileSync,
  openSync, writeFileSync, closeSync, fsyncSync, renameSync, unlinkSync, statSync, readdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  patchIdFor, mergePatchFile as sharedMergePatchFile, removePatchBlock as sharedRemovePatchBlock,
  acquireLock, releaseLock, writeFileAtomic, serializePatch, PATCH_LOCK_FILE,
} from '../../vendor-shared/index.mjs'
import { ENSURE_TIMEOUT_MS, manifestPath, patchPath, profileDir } from './paths.js'
import { readJson, writeJsonSafe } from './state.js'
import { runCli, tail } from './run-cli.js'
import { ensureEntry, npmModuleDir, storeDirOf } from './ensure.js'

// node:fs 直连端口（merge/lock 契约需要的方法）
const nodeFsPort = {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync, openSync,
  closeSync, fsyncSync, renameSync, unlinkSync, rmSync, readdirSync, copyFileSync,
}

/** 四写者共用的补丁锁（<profile>/.dsh-patch.lock）。 */
export function patchLockPath() {
  return join(profileDir(), PATCH_LOCK_FILE)
}

/** 统一 patch id（vendor-shared patchIdFor 语义；旧 id 不重生成）。 */
export function patchInstanceId(packId, pluginId) {
  return patchIdFor(packId, pluginId)
}

/** 契约 marker（`## hotplug:<packId>`）；旧单 # 形态读兼容。 */
export function patchMarker(packId) { return `## hotplug:${packId}` }

/** 旧内联形态 marker（`- insert:  # hotplug:<packId>`，迁移期移除用）。 */
export function legacyInlineMarker(packId) { return `# hotplug:${packId}` }

/**
 * 块内容（单个 YAML 顶层数组项；marker 单独成行，CONTRACT.md §4）。
 * 审计修复（v5 阶段 5）：曾手拼 YAML（单引号 name + JSON.stringify config）——
 * config 字符串值含字面换行时产物为坏 YAML；现收敛到 vendor-shared serializePatch
 * （yaml 序列化 + 回读自校验，产物必然可解析且语义等价）。
 * @param {object} pack parseHotpack 产物
 * @returns {{ok: boolean, text?: string, error?: Error}}
 */
export function buildPatchBlock(pack) {
  const r = serializePatch(pack)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, text: r.yamlText }
}

/**
 * 追加（或替换）hotplug 分节块：锁内 mergePatchFile（分节保留，永不整文件覆盖）。
 */
export function appendPatchBlock(pack) {
  const path = patchPath()
  const lockPath = patchLockPath()
  const a = acquireLock(nodeFsPort, lockPath, { waitMs: 10000, refreshMs: 5000 })
  if (!a.ok) return { ok: false, error: `patch 锁获取失败：${a.error.message}` }
  try {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    // 已存在同名块（新 ## 或旧 # 形态）→ 拒绝（状态不一致保护；deactivate 后可重挂）
    if (text.includes(patchMarker(pack.id)) || text.includes(legacyInlineMarker(pack.id))) {
      return { ok: false, error: 'patch 中已存在同名 hotplug 块（状态可能不一致，请先 deactivate）' }
    }
    const block = buildPatchBlock(pack)
    if (!block.ok) return { ok: false, error: `patch 块序列化失败：${block.error.message}` }
    const r = sharedMergePatchFile(nodeFsPort, path, 'hotplug', pack.id, block.text.replace(/\n$/, ''))
    if (!r.ok) return { ok: false, error: r.error.message }
    return { ok: true }
  } finally {
    releaseLock(nodeFsPort, lockPath, { pid: process.pid, fd: a.fd, refresh: a.refresh })
  }
}

/**
 * 移除 hotplug 分节块（按 marker 匹配，不按 id 内容——迁移规则 §9）。
 * 兼容旧内联形态（`- insert:  # hotplug:<packId>`）：按行手术移除。
 * 审计修复：返回统一为 {ok, removed?, error?}（与 appendPatchBlock/shared 一致）；
 * 此前锁获取失败静默 return false，调用方 unmountPack 丢弃返回值——deactivate 会
 * 在 patch 块实际未移除的情况下仍返回成功，破坏"停用即卸载"契约。
 * @returns {{ok: boolean, removed?: boolean, error?: string}}
 */
export function removePatchBlock(packId) {
  const path = patchPath()
  const lockPath = patchLockPath()
  const a = acquireLock(nodeFsPort, lockPath, { waitMs: 10000, refreshMs: 5000 })
  if (!a.ok) return { ok: false, error: `patch 锁获取失败：${a.error.message}` }
  try {
    if (!existsSync(path)) return { ok: true, removed: false }
    // 1) 契约形态（## / # 单行 marker）
    const r = sharedRemovePatchBlock(nodeFsPort, path, 'hotplug', packId)
    if (!r.ok) return { ok: false, error: r.error.message }
    if (r.removed) return { ok: true, removed: true }
    // 2) 旧内联形态（- insert:  # hotplug:<packId>）
    const lines = readFileSync(path, 'utf8').split('\n')
    const markerRe = new RegExp(`#\\s*hotplug:${packId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    const start = lines.findIndex((line) => markerRe.test(line))
    if (start === -1) return { ok: true, removed: false }
    let end = start + 1
    while (end < lines.length && (lines[end].startsWith(' ') || lines[end].startsWith('\t') || lines[end].trim() === '')) end++
    lines.splice(start, end - start)
    const w = writeFileAtomic(nodeFsPort, path, lines.join('\n'), { errorCode: 'ERR_INSTALL_FAILED' })
    if (!w.ok) return { ok: false, error: w.error.message }
    return { ok: true, removed: true }
  } finally {
    releaseLock(nodeFsPort, lockPath, { pid: process.pid, fd: a.fd, refresh: a.refresh })
  }
}

export function bundlePkgNames(pack) {
  const names = []
  for (const entry of pack.plugins) {
    const meta = readJson(join(storeDirOf(entry), 'package.json'))
    if (meta?.dsh?.bundle?.patch !== undefined) names.push(entry.name)
  }
  return names
}

export function linkEntryIntoProfile(entry) {
  const target = storeDirOf(entry)
  const manifest = readJson(manifestPath())
  if (manifest === null) return { ok: false, error: 'profile package.json 不可读' }
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[entry.name] = `link:${target.replace(/\\/g, '/')}`
  writeJsonSafe(manifestPath(), manifest)
  const linkPath = npmModuleDir(entry.name)
  if (!existsSync(linkPath)) {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, 'junction')
  }
  return { ok: true }
}

export function unlinkEntryFromProfile(entry, manifest) {
  let changed = false
  if (manifest.dependencies?.[entry.name] !== undefined && String(manifest.dependencies[entry.name]).startsWith('link:')) {
    delete manifest.dependencies[entry.name]
    changed = true
  }
  const linkPath = npmModuleDir(entry.name)
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { force: true })
      changed = true
    }
  } catch { /* 有意吞掉：尽力而为的清理/读取，失败不影响主流程 */ }
  return changed
}

export function addBundles(names) {
  if (names.length === 0) return
  const manifest = readJson(manifestPath())
  if (manifest === null) return
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  let changed = false
  for (const name of names) {
    if (!bundles.includes(name)) { bundles.push(name); changed = true }
  }
  if (changed) {
    manifest.dsh.profile.bundles = bundles
    writeJsonSafe(manifestPath(), manifest)
  }
}

export function removeBundles(names) {
  if (names.length === 0) return
  const manifest = readJson(manifestPath())
  if (manifest === null) return
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const next = bundles.filter((name) => !names.includes(name))
  if (next.length !== bundles.length) {
    manifest.dsh.profile.bundles = next
    writeJsonSafe(manifestPath(), manifest)
  }
}

// ---------- 激活 / 卸载 ----------

export async function unmountPack(pack) {
  const removed = removePatchBlock(pack.id)
  if (!removed.ok) return { ok: false, error: removed.error }
  const bundleNames = bundlePkgNames(pack)
  removeBundles(bundleNames)
  const manifest = readJson(manifestPath())
  const linkEntries = pack.plugins.filter((entry) => entry.source.type !== 'npm')
  if (manifest !== null) {
    let changed = false
    for (const entry of linkEntries) changed = unlinkEntryFromProfile(entry, manifest) || changed
    if (changed) writeJsonSafe(manifestPath(), manifest)
  }
  const npmNames = pack.plugins
    .filter((entry) => entry.source.type === 'npm')
    .map((entry) => entry.name)
    .filter((name) => manifest?.dependencies?.[name] !== undefined)
  if (npmNames.length > 0) {
    const result = await runCli('pnpm', ['remove', ...npmNames], ENSURE_TIMEOUT_MS)
    if (result.code !== 0) {
      return { ok: false, error: `pnpm remove 失败（profile 可能残留依赖，可手动处理）：${tail(result.stderr || result.stdout)}` }
    }
  }
  return { ok: true }
}

/**
 * 回滚一次失败的挂载：以 unmountPack 作为逆操作（link / bundles / patch / npm 全撤销）。
 * 只撤销已写入的部分——unmountPack 各项均为"存在才移除"的幂等语义，故半挂载安全。
 * @param {object} pack
 */
async function rollbackMount(pack) {
  try { await unmountPack(pack) } catch { /* 回滚失败不覆盖主错误（尽力而为） */ }
}

export async function mountPack(pack) {
  const steps = []
  // 审计修复：挂载失败统一回滚（此前 gateway 只撤 patch+bundles，link: 依赖/junction
  // 与 ensureNpm 装入的 npm 包残留，形成半挂载）。现在 mount = 全有或全无。
  const fail = async (error) => {
    await rollbackMount(pack)
    return { ok: false, error, steps }
  }
  for (const entry of pack.plugins) {
    const ensured = await ensureEntry(entry)
    if (!ensured.ok) return fail(ensured.error)
    steps.push({ id: entry.id, name: entry.name, status: ensured.status, detail: ensured.detail })
  }
  const manifest = readJson(manifestPath())
  if (manifest === null) return fail('profile package.json 不可读')
  for (const entry of pack.plugins.filter((item) => item.source.type !== 'npm')) {
    const linked = linkEntryIntoProfile(entry)
    if (!linked.ok) return fail(linked.error)
  }
  addBundles(bundlePkgNames(pack))
  const patched = appendPatchBlock(pack)
  if (!patched.ok) return fail(patched.error)
  return { ok: true, steps, restartNeeded: true }
}
