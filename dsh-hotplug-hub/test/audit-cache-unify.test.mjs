// test/audit-cache-unify.test.mjs — github/path 缓存判定统一（单一真源审计）
//
// 背景：npm 的 cached 走 isNpmCached（版本 + 内部包名双校验），github/path 却只看
// 落地目录 package.json【存在性】——与 ensureGithub/ensurePath 的复用判定（存在 +
// 内部包名一致）漂移：预演说 reused、激活实际重新下载；串包/篡改残留被误报 cached。
// 契约：三类源统一走同一判定（isEntryCached），statusSync.cached / previewPack.action
// / ensure* reused 三处零漂移。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { statusSync, previewPack, importPackSync } from '../lib/core/status.js'
import { ensureGithub } from '../lib/core/ensure.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => {
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

function githubPack() {
  return {
    hotpack: '1.0', id: 'pack.g', name: 'G', version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-g', source: { type: 'github', repo: 'o/r', ref: 'v1' }, config: {} }],
  }
}

function pathPack() {
  const src = join(iso.dshHome, 'src', 'pkg-p')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
  return {
    hotpack: '1.0', id: 'pack.p', name: 'P', version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
  }
}

describe('github/path cached 判定统一', () => {
  it('github：store 目录 package.json 内部包名不符 → status cached:false', async () => {
    await importPackSync(JSON.stringify(githubPack()))
    // 预置串包残留：store 目录有 package.json 但 name 不是 pkg-g
    // （storeKeySegment 只编码 '/'；ref 'v1' 无 '/'，键为 o%2Fr#pkg-g@v1）
    const dir = join(iso.dshHome, 'hotplug-store', 'o%2Fr#pkg-g@v1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'other-pkg', version: '1.0.0' }))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.g').plugins[0]
    expect(plugin.cached).toBe(false)
  })

  it('github：内部包名一致 → cached:true；且与 ensureGithub reused 判定一致', async () => {
    await importPackSync(JSON.stringify(githubPack()))
    const dir = join(iso.dshHome, 'hotplug-store', 'o%2Fr#pkg-g@v1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg-g', version: '1.0.0' }))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.g').plugins[0]
    expect(plugin.cached).toBe(true)
    // 同一判定下 ensureGithub 直接 reused（零下载）
    const r = await ensureGithub(githubPack().plugins[0])
    expect(r.ok).toBe(true)
    expect(r.status).toBe('reused')
  })

  it('github：串包残留 → preview action:download（不是 reused）', async () => {
    await importPackSync(JSON.stringify(githubPack()))
    const dir = join(iso.dshHome, 'hotplug-store', 'o%2Fr#pkg-g@v1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'other-pkg', version: '1.0.0' }))
    const prev = await previewPack('pack.g')
    expect(prev.ok).toBe(true)
    expect(prev.refs[0].action).toBe('download')
  })

  it('path：内部包名不符 → status cached:false + preview action:error（与 ensurePath 一致）', async () => {
    const pack = pathPack()
    await importPackSync(JSON.stringify(pack))
    // 篡改路径源内部包名
    writeFileSync(join(pack.plugins[0].source.path, 'package.json'), JSON.stringify({ name: 'not-pkg-p', version: '1.0.0' }))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.p').plugins[0]
    expect(plugin.cached).toBe(false)
    const prev = await previewPack('pack.p')
    expect(prev.ok).toBe(true)
    expect(prev.refs[0].action).toBe('error')
    expect(prev.refs[0].detail).toMatch(/不一致|包名/)
  })

  it('path：内部包名一致 → cached:true + preview reused（回归）', async () => {
    const pack = pathPack()
    await importPackSync(JSON.stringify(pack))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.p').plugins[0]
    expect(plugin.cached).toBe(true)
    const prev = await previewPack('pack.p')
    expect(prev.refs[0].action).toBe('reused')
  })

  it('github：store 目录为空（无 package.json）→ cached:false + download（回归）', async () => {
    await importPackSync(JSON.stringify(githubPack()))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.g').plugins[0]
    expect(plugin.cached).toBe(false)
    const prev = await previewPack('pack.g')
    expect(prev.refs[0].action).toBe('download')
  })

  it('github ref 含斜杠：store 键 %2F 编码后判定仍正确（H-10 回归叠加）', async () => {
    const pack = {
      hotpack: '1.0', id: 'pack.g2', name: 'G2', version: '1.0.0',
      plugins: [{ id: 'main', name: 'pkg-g', source: { type: 'github', repo: 'o/r', ref: 'feature/x' }, config: {} }],
    }
    await importPackSync(JSON.stringify(pack))
    // 落地键：storeKeySegment('o/r')+'#'+storeKeySegment('pkg-g')+'@'+storeKeySegment('feature/x') = o%2Fr#pkg-g@feature%2Fx
    const dir = join(iso.dshHome, 'hotplug-store', 'o%2Fr#pkg-g@feature%2Fx')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg-g', version: '1.0.0' }))
    const s = statusSync()
    const plugin = s.packs.find((p) => p.id === 'pack.g2').plugins[0]
    expect(plugin.cached).toBe(true)
    const r = await ensureGithub(pack.plugins[0])
    expect(r.status).toBe('reused')
  })
})
