// test/audit-mount-exception.test.mjs — mountPack 异常安全（全有或全无审计）
//
// 背景：mountPack 此前只处理 {ok:false} 返回值；ensureEntry / linkEntryIntoProfile /
// writeJsonSafe 的同步【异常】（EACCES/ENOTDIR/EPERM 等）会穿透挂载循环，
// rollbackMount 完全不执行 → 半挂载（link: 依赖已写、npm 已装、patch 块未写）。
// 契约：mount = 全有或全无，任何异常都转化为失败 + 回滚，绝不裸抛。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync } from 'node:fs'
import { mountPack } from '../lib/core/patch.js'
import { readJson } from '../lib/core/state.js'
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

function pathPack() {
  const src = join(iso.dshHome, 'src', 'pkg-p')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-p', version: '1.0.0' }))
  return {
    hotpack: '1.0', id: 'pack.e', name: 'E', version: '1.0.0',
    plugins: [{ id: 'main', name: 'pkg-p', source: { type: 'path', path: src }, config: {} }],
  }
}

describe('mountPack 异常安全', () => {
  it('link 阶段抛异常（node_modules 被文件占位 → mkdir ENOTDIR/EEXIST）→ ok:false + 回滚 link: 依赖，无 patch 块', async () => {
    const pack = pathPack()
    // 把 profile/node_modules 换成普通文件：linkEntryIntoProfile 的 mkdirSync 抛错
    rmSync(join(iso.profile, 'node_modules'), { recursive: true, force: true })
    writeFileSync(join(iso.profile, 'node_modules'), 'occupied')
    let threw = false
    let r
    try {
      r = await mountPack(pack)
    } catch (e) {
      threw = true
    }
    expect(threw).toBe(false) // 不得裸抛
    expect(r.ok).toBe(false)
    // 回滚：manifest 里不得残留 link: 依赖
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(manifest.dependencies['pkg-p']).toBeUndefined()
    // patch 块未写入（或已回滚）
    const patchFile = join(iso.profile, 'cordis.patch.yml')
    const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
    expect(patchText).not.toContain('hotplug:pack.e')
  })

  it('bundle 阶段后的 appendPatchBlock 失败路径仍全量回滚（回归：无残留）', async () => {
    const pack = pathPack()
    // 预置同名 hotplug 块 → appendPatchBlock 拒绝（状态不一致保护）→ 走 fail 路径
    mkdirSync(iso.profile, { recursive: true })
    writeFileSync(join(iso.profile, 'cordis.patch.yml'), `## hotplug:pack.e\n- insert:\n  - id: stale\n    name: pkg-p\n`)
    const r = await mountPack(pack)
    expect(r.ok).toBe(false)
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(manifest.dependencies['pkg-p']).toBeUndefined()
    const linkPath = join(iso.profile, 'node_modules', 'pkg-p')
    expect(existsSync(linkPath)).toBe(false)
  })

  it('成功路径回归：正常挂载仍产出 link 依赖 + patch 块', async () => {
    const pack = pathPack()
    const r = await mountPack(pack)
    expect(r.ok).toBe(true)
    expect(r.installedNpm).toEqual([])
    const manifest = readJson(join(iso.profile, 'package.json'))
    expect(String(manifest.dependencies['pkg-p'])).toMatch(/^link:/)
    expect(lstatSync(join(iso.profile, 'node_modules', 'pkg-p')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(iso.profile, 'cordis.patch.yml'), 'utf8')).toContain('hotplug:pack.e')
  })
})
