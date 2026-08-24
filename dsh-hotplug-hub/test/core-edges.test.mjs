// test/core-edges.test.mjs — 杂项核心边缘：run-cli tail / runCli 输出上限与退出码 /
// state 工具（readJsonStatus / loadPackManifest / packDirExists / 写失败抛错）/
// hotpack 适配层（错误码保留 / memory / 码点截断 / 214 上限 / dshpack 桥接）/
// 故障注入（hotpack.json 或 package.json 变目录 → 结构化失败不裸抛）。
// 子进程仅用 process.execPath 绝对路径（不依赖 PATH）；隔离 DSH_HOME，零真实 ~/.dsh 写入。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { runCli, tail } from '../lib/core/run-cli.js'
import {
  writeTextSafe, writeJsonSafe, readJson, readJsonStatus, readState, loadPackManifest, packDirExists,
} from '../lib/core/state.js'
import { parseHotpack, dshpackToHotpack } from '../lib/core/hotpack.js'
import { importPackSync, statusSync, checkAsync } from '../lib/core/status.js'
import { mountPack } from '../lib/core/patch.js'
import { toWellFormed } from '../lib/core/market.js'
import { OUTPUT_CAP, packsDir, statePath } from '../lib/core/paths.js'
import { applyIsolatedEnv, isolatedDsh, samplePack } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('tail（run-cli.js 尾行截取）', () => {
  it('默认取末 8 行；自定义行数', () => {
    const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    expect(tail(ten.join('\n'))).toBe(ten.slice(-8).join('\n'))
    expect(tail('l1\nl2\nl3', 2)).toBe('l2\nl3')
    expect(tail('l1\nl2\nl3', 10)).toBe('l1\nl2\nl3') // 行数不足 n → 全量
    expect(tail('only', 3)).toBe('only')
  })

  it('空 / 纯空白 / null → 空串', () => {
    expect(tail('')).toBe('')
    expect(tail('   ')).toBe('')
    expect(tail(null)).toBe('')
    expect(tail(undefined)).toBe('')
    expect(tail('\n\n  \n')).toBe('')
  })

  it('CRLF：按 \\n 切行、行尾 \\r 原样保留（当前实现行为），首尾空白先 trim', () => {
    expect(tail('a\r\nb\r\nc\r\n')).toBe('a\r\nb\r\nc') // 末行 \r\n 被 trim
    expect(tail('a\r\nb\r\nc', 2)).toBe('b\r\nc') // \r 留在行内
  })
})

describe('runCli（process.execPath 绝对路径，不依赖 PATH）', () => {
  it('退出码透传（exit 7 → code:7, signal:null）', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.exit(7)'], 10000, { cwd: iso.dshHome })
    expect(r.code).toBe(7)
    expect(r.signal).toBeNull()
  })

  it('stderr 捕获', async () => {
    const r = await runCli(process.execPath, ['-e', 'console.error("boom-stderr")'], 10000, { cwd: iso.dshHome })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('boom-stderr')
    expect(r.stdout).toBe('')
  })

  it('默认 OUTPUT_CAP：30 万字符输出被截断（≥cap 且 ≤cap+单个 chunk-1）', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write("x".repeat(300000))'], 10000, { cwd: iso.dshHome })
    expect(OUTPUT_CAP).toBe(65536)
    // 截断按数据块粒度：停在第首个「累计 ≥ cap」的块边界，不会无限吃满
    expect(r.stdout.length).toBeGreaterThanOrEqual(OUTPUT_CAP)
    expect(r.stdout.length).toBeLessThanOrEqual(OUTPUT_CAP + 65535)
    expect(r.stdout.length).toBeLessThan(300000)
    expect(r.stdout).toMatch(/^x+$/) // 内容连续，无空洞
  })

  it('maxOutput 放宽生效（150000 → 保留 ≥150000，仍远小于全量）', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write("y".repeat(300000))'], 10000, { cwd: iso.dshHome, maxOutput: 150000 })
    expect(r.stdout.length).toBeGreaterThanOrEqual(150000)
    expect(r.stdout.length).toBeLessThanOrEqual(150000 + 65535)
    expect(r.stdout.length).toBeLessThan(300000)
  })

  it('maxOutput 非法（0 / 负数）→ 回落默认 OUTPUT_CAP', async () => {
    for (const maxOutput of [0, -5]) {
      const r = await runCli(process.execPath, ['-e', 'process.stdout.write("z".repeat(200000))'], 10000, { cwd: iso.dshHome, maxOutput })
      expect(r.stdout.length, String(maxOutput)).toBeLessThanOrEqual(OUTPUT_CAP + 65535)
      expect(r.stdout.length, String(maxOutput)).toBeLessThan(200000)
    }
  })

  it('不存在的命令 → {code:null, signal:"error"}（不抛异常）', async () => {
    const r = await runCli('Z:\\definitely-missing-hp-test.exe', ['--version'], 10000, { cwd: iso.dshHome })
    expect(r.code).toBeNull()
    expect(r.signal).toBe('error')
    expect(r.stderr).toContain('ENOENT')
  })
})

describe('state.js 工具（直接单测）', () => {
  it('writeTextSafe：目标路径是已存在目录 → 抛错（writeFileAtomic 失败不静默）', () => {
    const dir = join(iso.dshHome, 'occupied-dir')
    mkdirSync(dir, { recursive: true })
    expect(() => writeTextSafe(dir, 'x')).toThrow()
    // 同目录无 .tmp 残留（原子写失败自清理）
    expect(existsSync(join(iso.dshHome, 'occupied-dir.tmp'))).toBe(false)
  })

  it('writeJsonSafe：自动创建多级父目录并落盘', () => {
    const f = join(iso.dshHome, 'a', 'b', 'c', 'x.json')
    writeJsonSafe(f, { ok: 1 })
    expect(readJson(f)).toEqual({ ok: 1 })
  })

  it('readJsonStatus：missing / invalid / ok 三态', () => {
    const missing = join(iso.dshHome, 'nope.json')
    expect(readJsonStatus(missing)).toEqual({ status: 'missing' })
    const bad = join(iso.dshHome, 'bad.json')
    writeFileSync(bad, '{broken')
    expect(readJsonStatus(bad).status).toBe('invalid')
    const good = join(iso.dshHome, 'good.json')
    writeFileSync(good, '{"a":1}')
    const r = readJsonStatus(good)
    expect(r.status).toBe('ok')
    expect(r.value).toEqual({ a: 1 })
  })

  it('readState：损坏（半截 JSON / 非对象形状）→ corrupted:true', () => {
    mkdirSync(join(iso.dshHome, 'hotplug-hub'), { recursive: true })
    writeFileSync(statePath(), '{ "activePack": "pack.x", "hist')
    expect(readState().corrupted).toBe(true)
    writeFileSync(statePath(), '[1,2,3]')
    expect(readState().corrupted).toBe(true)
    writeFileSync(statePath(), JSON.stringify({ version: 1, activePack: 'pack.x', history: [] }))
    expect(readState().corrupted).toBeUndefined()
    expect(readState().activePack).toBe('pack.x')
  })

  it('loadPackManifest：missing（不存在 / 非法 id）/ invalid（篡改）/ ok（导入往返）', () => {
    expect(loadPackManifest('no-such')).toEqual({ status: 'missing' })
    expect(loadPackManifest('../x').status).toBe('missing') // PACK_ID_RE 拒绝穿越式 id
    // 篡改：plugins 空数组 → 权威校验失败
    const dir = join(packsDir(), 'pack.bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'hotpack.json'), JSON.stringify({ hotpack: '1.0', id: 'pack.bad', name: 'B', version: '1.0.0', plugins: [] }))
    const invalid = loadPackManifest('pack.bad')
    expect(invalid.status).toBe('invalid')
    expect(typeof invalid.error).toBe('string')
    expect(invalid.error.length).toBeGreaterThan(0)
    // 往返：importPackSync 写入的合法 manifest 可复验
    importPackSync(JSON.stringify(samplePack({ id: 'pack.rt' })))
    const ok = loadPackManifest('pack.rt')
    expect(ok.status).toBe('ok')
    expect(ok.pack.id).toBe('pack.rt')
    expect(ok.pack.memory).toEqual({ keep: true })
  })

  it('packDirExists：真目录 true / 缺失 false / 穿越 id false / 同名文件（非目录）false', () => {
    mkdirSync(join(packsDir(), 'pack.real'), { recursive: true })
    writeFileSync(join(packsDir(), 'pack.file'), 'not a dir')
    expect(packDirExists('pack.real')).toBe(true)
    expect(packDirExists('pack.nope')).toBe(false)
    expect(packDirExists('../x')).toBe(false)
    expect(packDirExists('pack.file')).toBe(false)
  })
})

describe('hotpack.js 适配层（错误码 / 展示约束 / dshpack 桥接）', () => {
  function validInput(overrides = {}) {
    return {
      hotpack: '1.0',
      id: 'pack.x',
      name: 'X Pack',
      version: '1.0.0',
      plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.0.0' }],
      ...overrides,
    }
  }

  it('失败保留 shared 的 ERR_ASSEMBLY_* 错误码（CLI 域 32 码契约透传）', () => {
    const badJson = parseHotpack('{not json')
    expect(badJson.ok).toBe(false)
    expect(badJson.code).toBe('ERR_ASSEMBLY_INVALID_JSON')
    expect(typeof badJson.error).toBe('string')
    const badVer = parseHotpack(validInput({ version: '1.02.3' }))
    expect(badVer.code).toBe('ERR_ASSEMBLY_FIELD')
    expect(badVer.error).toContain('version')
    const badVer2 = parseHotpack(validInput({ plugins: [{ id: 'p', name: 'pkg', source: { type: 'npm' }, version: '1.2.3-a..b' }] }))
    expect(badVer2.code).toBe('ERR_ASSEMBLY_FIELD')
    const unsupported = parseHotpack(validInput({ hotpack: '2.0' }))
    expect(unsupported.code).toBe('ERR_ASSEMBLY_UNSUPPORTED')
  })

  it('memory:{keep:true} + tags 码点安全截断：30 个 emoji → 24 个完整 emoji', () => {
    const emoji = '😀'
    const r = parseHotpack(validInput({ tags: [emoji.repeat(30), 'ok'] }))
    expect(r.ok).toBe(true)
    expect(r.pack.memory).toEqual({ keep: true })
    expect(Array.from(r.pack.tags[0])).toHaveLength(24)
    expect(toWellFormed(r.pack.tags[0])).toBe(r.pack.tags[0]) // 无孤立代理
    expect(() => encodeURIComponent(r.pack.tags[0])).not.toThrow()
    expect(r.pack.tags[1]).toBe('ok')
  })

  it('maxNameLength=214：插件名 215 字符拒绝、214 字符放行', () => {
    expect(parseHotpack(validInput({ plugins: [{ id: 'p', name: 'a'.repeat(215), source: { type: 'npm' }, version: '1.0.0' }] })).ok).toBe(false)
    expect(parseHotpack(validInput({ plugins: [{ id: 'p', name: 'a'.repeat(214), source: { type: 'npm' }, version: '1.0.0' }] })).ok).toBe(true)
  })

  it('allowLegacy:false：legacy {packId,bundles} 形态拒绝', () => {
    const r = parseHotpack({ packId: 'pack.legacy', name: 'N', version: '1.0.0', bundles: [{ id: 'b', package: 'pkg', version: '1.0.0' }] })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_ASSEMBLY_UNSUPPORTED')
    expect(r.error).toContain('hotpack')
  })

  it('dshpackToHotpack：合法 .dshpack → hotpack（plugins + memory 适配）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'cn.pack', name: 'N', version: '1.0.0',
      bundles: [{ id: 'b1', package: 'pkg-a', version: '1.0.0' }],
    }))
    expect(r.ok).toBe(true)
    expect(r.pack.id).toBe('cn.pack')
    expect(r.pack.plugins).toHaveLength(1)
    expect(r.pack.plugins[0].name).toBe('pkg-a')
    expect(r.pack.plugins[0].source.type).toBe('npm')
    expect(r.pack.memory).toEqual({ keep: true })
  })

  it('dshpackToHotpack：path 源拒绝（只支持 npm/github，不静默降级 npm）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'N', version: '1.0.0',
      bundles: [{ id: 'b', package: 'pkg-a', version: '1.0.0', source: { type: 'path', path: 'C:/x' } }],
    }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('source 只支持 npm / github')
  })

  it('dshpackToHotpack：npm 缺精确 version 拒绝', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'N', version: '1.0.0',
      bundles: [{ id: 'b', package: 'pkg-a' }],
    }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('version')
  })

  it('dshpackToHotpack：产物复验（bundle 里的坏插件名在桥接后被 parseHotpack 拒收）', () => {
    const r = dshpackToHotpack(JSON.stringify({
      packId: 'x', name: 'N', version: '1.0.0',
      bundles: [{ id: 'b', package: 'pkg&evil', version: '1.0.0' }],
    }))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ERR_ASSEMBLY_FIELD')
    expect(r.error).toContain('pkg&evil')
  })
})

describe('故障注入（真实 fs：关键文件被目录占位）', () => {
  /** 合法 path 源包（激活零网络零 pnpm）。 */
  function pathPack() {
    const src = join(iso.dshHome, 'src', 'pkg-p')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
    return samplePack({
      id: 'pack.f',
      plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
    })
  }

  it('packs/<id>/hotpack.json 是目录 → loadPackManifest invalid（存在但不可读）→ statusSync 跳过且不崩', () => {
    importPackSync(JSON.stringify(pathPack()))
    const manifestFile = join(packsDir(), 'pack.f', 'hotpack.json')
    rmSync(manifestFile, { force: true })
    mkdirSync(manifestFile, { recursive: true }) // 读失败（EISDIR）
    expect(loadPackManifest('pack.f').status).toBe('invalid') // 审查修复后：存在但不可读 = invalid（不再 lossy 报 missing）
    const s = statusSync() // 不抛
    expect(s.packs.map((p) => p.id)).toEqual([])
    expect(s.stateOk).toBe(true)
  })

  it('profile package.json 是目录 → checkAsync manifestOk:false，statusSync 照常返回', async () => {
    rmSync(join(iso.profile, 'package.json'))
    mkdirSync(join(iso.profile, 'package.json'), { recursive: true })
    const r = await checkAsync()
    expect(r.manifestOk).toBe(false)
    const s = statusSync()
    expect(s.profile.dir).toContain('web')
    expect(s.packs).toEqual([])
  })

  it('mountPack：manifestPath 是目录 → ok:false（profile package.json 不可读），不裸抛', async () => {
    const pack = pathPack()
    rmSync(join(iso.profile, 'package.json'))
    mkdirSync(join(iso.profile, 'package.json'), { recursive: true })
    let threw = false
    let r
    try {
      r = await mountPack(pack)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('profile package.json 不可读')
    // 回滚路径走完后未写 patch 块（全有或全无）
    const patchFile = join(iso.profile, 'cordis.patch.yml')
    expect(existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '').not.toContain('hotplug:pack.f')
  })
})
