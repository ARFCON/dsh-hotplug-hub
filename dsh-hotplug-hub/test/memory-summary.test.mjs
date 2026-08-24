/**
 * test/memory-summary.test.mjs — 记忆中枢 tab 真实数据源验收（FD-1 去假数据）。
 *
 * 此前缺陷：桌面「记忆中枢」tab 渲染 data.store.entries（hotplug-store 插件缓存
 * 目录名）冒充"全局记忆包"——与 ~/.dsh/memory-hub 毫无关系。
 * 根治：statusSync 新增 memory 摘要（只认含 pack.json 的目录 + entries/*.md 实数）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statusSync } from '../lib/core/status.js'

const ORIG_DSH_HOME = process.env.DSH_HOME
const ORIG_DSH_HOTPLUG_ROOT = process.env.DSH_HOTPLUG_ROOT

let hubRoot

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-status-mem-'))
  hubRoot = join(base, '.dsh')
  process.env.DSH_HOME = hubRoot
  delete process.env.DSH_HOTPLUG_ROOT
})

afterEach(() => {
  if (ORIG_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIG_DSH_HOME
  if (ORIG_DSH_HOTPLUG_ROOT !== undefined) process.env.DSH_HOTPLUG_ROOT = ORIG_DSH_HOTPLUG_ROOT
  rmSync(hubRoot, { recursive: true, force: true })
})

describe('statusSync memory 摘要（真实记忆包，非 hotplug-store 假数据）', () => {
  it('空目录 → 空摘要（dir 指向 memory-hub）', () => {
    const st = statusSync()
    expect(st.memory).toBeTruthy()
    expect(st.memory.dir).toContain('memory-hub')
    expect(st.memory.packs).toEqual([])
    expect(st.memory.activeEntries).toBe(0)
  })

  it('真实记忆包（pack.json + entries/*.md）按实数统计', () => {
    const pack = join(hubRoot, 'memory-hub', 'global-pack')
    mkdirSync(join(pack, 'entries'), { recursive: true })
    writeFileSync(join(pack, 'pack.json'), JSON.stringify({ memoryPackId: 'global-pack', scope: 'global', schemaVersion: 1, keywords: [], entries: 2 }))
    writeFileSync(join(pack, 'entries', 'a.md'), '---\nid: "mem-0000000000000001"\ntitle: "A"\n---\n\n正文')
    writeFileSync(join(pack, 'entries', 'b.md'), '---\nid: "mem-0000000000000002"\ntitle: "B"\n---\n\n正文')
    const st = statusSync()
    expect(st.memory.packs).toEqual([{ id: 'global-pack', entries: 2 }])
    expect(st.memory.activeEntries).toBe(2)
  })

  it('无 pack.json 的目录不算记忆包（logs/杂目录不误报）', () => {
    const hub = join(hubRoot, 'memory-hub')
    mkdirSync(join(hub, 'logs', 'daily'), { recursive: true })
    mkdirSync(join(hub, 'not-a-pack', 'entries'), { recursive: true })
    writeFileSync(join(hub, 'not-a-pack', 'entries', 'x.md'), 'junk')
    const st = statusSync()
    expect(st.memory.packs).toEqual([])
  })

  it('多包稳定排序（id 字典序）', () => {
    for (const id of ['zeta-pack', 'alpha-pack', 'mid-pack']) {
      const pack = join(hubRoot, 'memory-hub', id)
      mkdirSync(join(pack, 'entries'), { recursive: true })
      writeFileSync(join(pack, 'pack.json'), JSON.stringify({ memoryPackId: id }))
    }
    const st = statusSync()
    expect(st.memory.packs.map((p) => p.id)).toEqual(['alpha-pack', 'mid-pack', 'zeta-pack'])
  })
})
