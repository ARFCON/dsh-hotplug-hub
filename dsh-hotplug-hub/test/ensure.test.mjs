// test/ensure.test.mjs — 源解析：path 校验 / zip URL / 解包树安全（M-39）/ env 净化
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ensurePath, githubZipUrls, verifyExtractedTree, storeDirOf, npmModuleDir } from '../lib/core/ensure.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('ensurePath / storeDirOf', () => {
  it('path 源：存在 + 包名一致 → reused', async () => {
    const src = join(iso.dshHome, 'src', 'pkg-x')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'pkg-x', version: '1.0.0' }))
    const r = await ensurePath({ name: 'pkg-x', source: { type: 'path', path: src } })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('reused')
    expect(r.path).toBe(src)
  })

  it('path 源：缺失 / 包名不一致 → 显式错误', async () => {
    const r1 = await ensurePath({ name: 'x', source: { type: 'path', path: join(iso.dshHome, 'nope') } })
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('不存在')
    const src = join(iso.dshHome, 'src', 'other')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'other' }))
    const r2 = await ensurePath({ name: 'declared', source: { type: 'path', path: src } })
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('不一致')
  })

  it('storeDirOf / npmModuleDir 分派', () => {
    expect(storeDirOf({ name: 'n', source: { type: 'github', ref: 'main' } })).toBe(join(iso.dshHome, 'hotplug-store', 'n@main'))
    expect(storeDirOf({ name: 'n', source: { type: 'path', path: 'C:/x' } })).toBe('C:/x')
    expect(storeDirOf({ name: '@s/n', source: { type: 'npm' } })).toBe(join(iso.profile, 'node_modules', '@s', 'n'))
    expect(npmModuleDir('@s/n')).toBe(join(iso.profile, 'node_modules', '@s', 'n'))
  })
})

describe('githubZipUrls', () => {
  it('官方 heads/tags + 每个镜像两条（主集 3 + 实验 3）', () => {
    const urls = githubZipUrls('o/r', 'main')
    expect(urls).toHaveLength(2 + 6 * 2)
    expect(urls[0]).toBe('https://codeload.github.com/o/r/zip/refs/heads/main')
    expect(urls[1]).toBe('https://codeload.github.com/o/r/zip/refs/tags/main')
    expect(urls[2]).toBe('https://ghfast.top/https://codeload.github.com/o/r/zip/refs/heads/main')
  })
})

describe('verifyExtractedTree（M-39）', () => {
  it('干净树通过', () => {
    const root = mkdtempSync(join(tmpdir(), 'hp-tree-'))
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'f.txt'), 'x')
    expect(verifyExtractedTree(root)).toBeNull()
  })

  it('符号链接指向根外 → 拒绝；指向根内 → 通过', () => {
    const base = mkdtempSync(join(tmpdir(), 'hp-tree2-'))
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    const badLink = join(root, 'esc')
    try {
      symlinkSync(outside, badLink, 'junction')
    } catch (e) {
      console.log('SKIP symlink: ' + e.code)
      return
    }
    expect(verifyExtractedTree(root)).toContain('越界')
    // 移除逃逸链接后再验证根内合法链接
    rmSync(badLink, { force: true })
    const inner = join(root, 'inner')
    mkdirSync(inner)
    const goodLink = join(root, 'alias')
    symlinkSync(inner, goodLink, 'junction')
    expect(verifyExtractedTree(root)).toBeNull()
  })

  it('解包根不可读（传入文件路径）→ 违规描述', () => {
    const root = mkdtempSync(join(tmpdir(), 'hp-tree3-'))
    const file = join(root, 'afile')
    writeFileSync(file, 'x')
    expect(verifyExtractedTree(file)).toContain('读取失败')
  })
})
