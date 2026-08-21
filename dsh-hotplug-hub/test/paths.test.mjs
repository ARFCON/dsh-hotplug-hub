// test/paths.test.mjs — 路径与常量（env 驱动）
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import {
  VERSION, GITHUB_MIRRORS, SOURCE_GITHUB, homeDir, hotplugRoot, packsDir, storeRoot,
  statePath, profileName, profileDir, manifestPath, patchPath, MARKET_CACHE_FILE,
} from '../lib/core/paths.js'
import { applyIsolatedEnv } from './helpers.mjs'

let restoreEnv = null
let dshHome = null

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'hp-paths-'))
  restoreEnv = applyIsolatedEnv(dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv() })

describe('lib/core/paths', () => {
  it('DSH_HOME 语义：.dsh 域目录（resolveDshRoot 契约）', () => {
    expect(homeDir()).toBe(dshHome)
    expect(hotplugRoot()).toBe(join(dshHome, 'hotplug-hub'))
    expect(packsDir()).toBe(join(dshHome, 'hotplug-hub', 'packs'))
    expect(storeRoot()).toBe(join(dshHome, 'hotplug-store'))
    expect(statePath()).toBe(join(dshHome, 'hotplug-hub', 'state.json'))
    expect(MARKET_CACHE_FILE()).toBe(join(hotplugRoot(), 'market-cache.json'))
  })

  it('DSH_HOME 尾部斜杠归一化（path.resolve 语义：双分隔符压平）', () => {
    // 平台正确：Windows 用反斜杠（此前写死 '\\\\' 在 Linux 上是文件名合法字符，
    // path.resolve 不归一化 → CI 失败）；统一用 path.sep 双分隔符。
    process.env.DSH_HOME = dshHome + sep + sep
    expect(homeDir()).toBe(dshHome)
  })

  it('DSH_HOME 未设定 → ~/.dsh（真实主目录语义，仅读不写）', () => {
    delete process.env.DSH_HOME
    const h = homeDir()
    expect(h.endsWith('.dsh')).toBe(true)
  })

  it('profile 选择：DSH_PROFILE 优先（存在时）；否则取第一个存在的 desktop→web→headless', () => {
    // env profile 存在（含 package.json）→ 优先
    mkdirSync(join(dshHome, 'profiles', 'custom'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', 'custom', 'package.json'), '{}')
    process.env.DSH_PROFILE = 'custom'
    expect(profileName()).toBe('custom')
    expect(profileDir()).toBe(join(dshHome, 'profiles', 'custom'))
    expect(manifestPath()).toBe(join(profileDir(), 'package.json'))
    expect(patchPath()).toBe(join(profileDir(), 'cordis.patch.yml'))
    // env profile 不存在但其它存在 → 落到存在的（desktop 优先于 web）
    delete process.env.DSH_PROFILE
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', 'desktop', 'package.json'), '{}')
    expect(profileName()).toBe('desktop')
    // 全不存在 → env 值；无 env → web
    rmSync(join(dshHome, 'profiles', 'desktop'), { recursive: true, force: true })
    rmSync(join(dshHome, 'profiles', 'web'), { recursive: true, force: true })
    process.env.DSH_PROFILE = 'ghost'
    expect(profileName()).toBe('ghost')
    delete process.env.DSH_PROFILE
    expect(profileName()).toBe('web')
  })

  it('GITHUB_MIRRORS = 契约主集 3 + 市场实验源 3（R-v5-5）', () => {
    expect(GITHUB_MIRRORS).toEqual([
      'https://ghfast.top/',
      'https://gh-proxy.com/',
      'https://ghproxy.net/',
      'https://mirror.ghproxy.com/',
      'https://ghproxy.cc/',
      'https://gh-proxy.net/',
    ])
    expect(SOURCE_GITHUB).toBe('github')
  })

  it('VERSION 从 package.json 读取', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
