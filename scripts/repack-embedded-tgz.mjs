#!/usr/bin/env node
/**
 * scripts/repack-embedded-tgz.mjs — 重打包 release/embedded 的两个内嵌 tgz（不改版本）
 *
 * 背景：release/embedded/*.tgz 是 EXE 内嵌的插件发布包，必须与仓库源码逐字节一致
 * （check-embedded-tgz.mjs CI 断言）。当 vendor 源码（尤其 vendor-shared 契约）变更后，
 * 旧 tgz 内容过期，须重新打包。本脚本只刷新 tgz 内容，【不提升任何版本号】——
 * 版本号变更归 Owner（开发文档/规范/版本号管理规范.md）。
 *
 * 与 repack-dseam-tgz.mjs 同源的 LF 归一化 + npm pack 逻辑：
 *   - 先把源码复制到临时副本，文本文件 CRLF → LF（tgz 恒为 LF，跨平台比对稳定）；
 *   - npm pack 生成标准 tgz，覆盖 release/embedded 下同名旧 tgz（版本不变，文件名不变）。
 *
 * 用法：node scripts/repack-embedded-tgz.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const embeddedDir = join(root, 'release', 'embedded')

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.yaml', '.txt', '.ps1', '.cs'])
function isTextFile(buf, name) {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (TEXT_EXT.has(ext)) return true
  if (ext === '') {
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 0) return false
    }
    return true
  }
  return false
}
function normalizeCrlf(buf, name) {
  if (!isTextFile(buf, name)) return buf
  const text = buf.toString('utf8')
  return text.includes('\r\n') ? Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8') : buf
}
function copyNormalized(src, dst) {
  const entries = readdirSync(src, { withFileTypes: true })
  for (const ent of entries) {
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    if (ent.isDirectory()) { mkdirSync(d, { recursive: true }); copyNormalized(s, d) }
    else writeFileSync(d, normalizeCrlf(readFileSync(s), ent.name))
  }
}

function repack(sourceDir, embeddedPrefix) {
  const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  const version = pkg.version
  const expectedTgz = `${pkg.name}-${version}.tgz`
  const staging = mkdtempSync(join(tmpdir(), 'repack-stage-'))
  const tmp = mkdtempSync(join(tmpdir(), 'repack-out-'))
  try {
    copyNormalized(sourceDir, staging)
    let packOut
    if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
      packOut = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', tmp], { cwd: staging, encoding: 'utf8' })
    } else {
      const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(npmCli)) {
        packOut = execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', tmp], { cwd: staging, encoding: 'utf8' })
      } else {
        packOut = execFileSync('cmd.exe', ['/d', '/s', '/c', `npm pack --pack-destination "${tmp}"`], { cwd: staging, encoding: 'utf8' })
      }
    }
    const tgzName = String(packOut).trim().split('\n').filter(Boolean).pop()
    if (tgzName !== expectedTgz) {
      throw new Error(`npm pack 产物名不符：期望 ${expectedTgz}，实际 ${tgzName}`)
    }
    const packed = join(tmp, tgzName)
    if (!existsSync(packed)) throw new Error(`npm pack 产物缺失：${tgzName}`)

    // 覆盖 embedded 下同名旧 tgz（版本不变；若历史残留其它版本名，一并清理）
    for (const f of readdirSync(embeddedDir)) {
      if (f.startsWith(embeddedPrefix) && f.endsWith('.tgz') && f !== expectedTgz) {
        rmSync(join(embeddedDir, f), { force: true })
        console.log(`removed stale tgz: ${f}`)
      }
    }
    const target = join(embeddedDir, expectedTgz)
    copyFileSync(packed, target)
    console.log(`embedded tgz refreshed: ${expectedTgz}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

repack(join(root, 'vendor', 'dseam-skillmcp'), 'dseam-skillmcp-')
repack(join(root, 'dsh-hotplug-hub', 'dsh-memory-hub'), 'dsh-memory-hub-')
console.log('done')
