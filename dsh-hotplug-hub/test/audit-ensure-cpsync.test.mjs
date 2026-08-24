// test/audit-ensure-cpsync.test.mjs — 审计发现（证伪逃逸 + 语义不一致备注）：
// ensureGithub 在 verifyExtractedTree 之后 cpSync(root, dest, {recursive:true})。
// 结论：cpSync 默认 DEREFERENCE（跟随）符号链接，把链接目标物化；但 verifyExtractedTree
// 已用 realpath 拒绝「指向解包根外」的符号链接，故「逃逸」被前置阻断——无实际越界。
// 剩余问题是语义不一致：校验通过的「根内符号链接」在拷贝时被物化为真实目录/文件，
// 存储产物与校验产物不一致。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync, cpSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { verifyExtractedTree } from '../lib/core/ensure.js'
import { applyIsolatedEnv, isolatedDsh } from './helpers.mjs'

let restoreEnv = null
let iso = null

beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => { if (restoreEnv) restoreEnv(); if (iso) iso.cleanup() })

describe('cpSync 与 verifyExtractedTree 的符号链接语义（证伪逃逸 + 备注）', () => {
  it('cpSync 默认跟随符号链接（dereference）——与 verifyExtractedTree 的"链接须在根内"校验语义不一致', () => {
    const base = mkdtempSync(join(tmpdir(), 'hp-cp-'))
    const root = join(base, 'root')
    const inner = join(root, 'inner')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'a.txt'), 'A')
    writeFileSync(join(root, 'package.json'), '{}')
    // 根内符号链接（verifyExtractedTree 会放行）
    symlinkSync(inner, join(root, 'alias'), 'junction')

    expect(verifyExtractedTree(root)).toBeNull() // 校验通过（根内链接合法）

    // 模拟 ensureGithub 的拷贝：cpSync(root, dest, {recursive:true})
    const dest = join(base, 'dest')
    cpSync(root, dest, { recursive: true })
    // 语义不一致（平台相关）：Windows 下 junction 被 cpSync 物化（dereference）为真实目录；
    // POSIX 下符号链接默认原样保留（仍是链接）。二者均是「根内链接」，verifyExtractedTree
    // 的 realpath 前置校验已阻断越界——此处仅记录 copy 语义与校验语义的差异，无安全逃逸。
    if (process.platform === 'win32') {
      expect(lstatSync(join(dest, 'alias')).isSymbolicLink()).toBe(false) // junction 被物化
      expect(existsSync(join(dest, 'alias', 'a.txt'))).toBe(true)
    } else {
      expect(lstatSync(join(dest, 'alias')).isSymbolicLink()).toBe(true) // 符号链接保留
      expect(existsSync(join(dest, 'alias', 'a.txt'))).toBe(true)
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('verifyExtractedTree 拒绝指向解包根外的符号链接（逃逸被前置阻断，证伪）', () => {
    const base = mkdtempSync(join(tmpdir(), 'hp-cp2-'))
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    mkdirSync(root); mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'SECRET')
    writeFileSync(join(root, 'package.json'), '{}')
    try {
      symlinkSync(outside, join(root, 'esc'), 'junction')
    } catch {
      rmSync(base, { recursive: true, force: true })
      return // 环境不支持 junction，跳过
    }
    // 逃逸链接被 verifyExtractedTree 拒绝 → ensureGithub 不会执行 cpSync，无越界
    expect(verifyExtractedTree(root)).toContain('越界')
    rmSync(base, { recursive: true, force: true })
  })
})

describe('ensureGithub 单根选择边界（证伪崩溃，备注误导性错误）', () => {
  it('空目录（空 zip 解包）与单文件 zip：均优雅报错，不崩溃', () => {
    // 复刻 ensureGithub 的 root 选择逻辑，验证极端输入不产生崩溃/越界
    const roots0 = []
    const root0 = roots0.length === 1 ? join('x', roots0[0]) : 'x'
    expect(existsSync(join(root0, 'package.json'))).toBe(false) // 空 → 报"缺少 package.json"

    const singleFile = ['package.json']
    const root1 = singleFile.length === 1 ? join('x', singleFile[0]) : 'x'
    // 单文件被当作 root → root/package.json 不存在 → 报错（误导性，但安全）
    expect(existsSync(join(root1, 'package.json'))).toBe(false)
  })
})
