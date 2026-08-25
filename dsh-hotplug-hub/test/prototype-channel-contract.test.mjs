// test/prototype-channel-contract.test.mjs — 页面 ↔ C# 外壳 postMessage 命令契约双向一致性
//
// 契约（prototype.html 头部注释与 release/src/Main.cs WebMessageReceived 一一对应）：
//   页面 → 外壳：window.chrome.webview.postMessage('<command>' 或 '<prefix>:' + payload)
//   外壳 → 页面：ExecuteScriptAsync 注入 __setXxx 回推 + 引导期主动拉取
// 本测试静态抽取两侧命令集，双向断言：
//   1) 页面发送的每条命令都必须被外壳识别（无死发送——发给没人处理的命令是静默失效）；
//   2) 外壳处理的每条命令都必须有发送方（页面直接发送、C# 注入脚本发送，或显式白名单
//      中的遗留项）——白名单与实际差一条都会失败，防止契约漂移。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const html = readFileSync(join(repoRoot, 'dsh-hotplug-hub', 'dsh-pack-hub', 'prototype.html'), 'utf8')
const mainCs = readFileSync(join(repoRoot, 'release', 'src', 'Main.cs'), 'utf8')
// 只扫页面 <script> 体（样式/标记中的字样不参与契约）；与 prototype-ai.test.mjs 同一提取口径
const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/* ---------------- 页面侧命令抽取 ---------------- */
// 字面量定界：兼容单引号 / 双引号 / 模板字符串三种书写（缺一种都会漏命令 → 死发送漏检）
const Q = "(['\"`])"
/** 收集页面所有发送形态：直接 postMessage / 三元前缀 / postOrToast / bind / postPluginOp / mk。 */
function extractPageCommands(src) {
  const literals = new Set() // 带 payload 边界的完整字面量（前缀命令以 ':' 结尾或内联 payload）
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') // 排除块注释续行与行注释
  })
  const push = (m) => { if (m) literals.add(m) }
  for (const line of codeLines) {
    // 直接发送：postMessage('x') / postMessage("x:") / postMessage(`x`) …（字面量后随 ) , + 均可）
    for (const m of line.matchAll(new RegExp(`postMessage\\(${Q}([^'"\`]+)\\1`, 'g'))) push(m[2])
    // 三元前缀（仅限发送行：postMessage 直发或四个包装器调用——文件其余三元不参与契约）
    if (line.includes('postMessage(') || /postPluginOp\(|postOrToast\(|\bmk\('/.test(line)) {
      for (const m of line.matchAll(new RegExp(`\\?\\s*${Q}([^'"\`]+?)\\1\\s*:\\s*${Q}([^'"\`]+?)\\3`, 'g'))) { push(m[2]); push(m[4]) }
    }
    // 包装器调用点：postOrToast / bind / postPluginOp / mk（msg 均为字面量，后随 , ) 或 + 拼接）
    for (const m of line.matchAll(new RegExp(`postOrToast\\(${Q}([^'"\`]+)\\1\\s*[,)]`, 'g'))) push(m[2])
    for (const m of line.matchAll(new RegExp(`bind\\('[^']+',\\s*${Q}([^'"\`]+)\\1\\s*\\)`, 'g'))) push(m[2])
    for (const m of line.matchAll(new RegExp(`postPluginOp\\(${Q}([^'"\`]+)\\1\\s*[,)+]`, 'g'))) push(m[2])
    for (const m of line.matchAll(new RegExp(`\\bmk\\('[^']*',\\s*'[^']*',\\s*${Q}([^'"\`]+)\\1\\s*\\)`, 'g'))) push(m[2])
  }
  return [...literals].map((s) => s.trim()).filter(Boolean)
}

/* ---------------- 外壳侧命令抽取 ---------------- */
function extractShellCommands(cs) {
  const exact = new Set()
  const prefixes = new Set()
  // 剥离 C# 行注释（如未来出现 `// 已移除: message == "oldCmd"` 不得被当活处理器）
  const code = cs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const m of code.matchAll(/message == "([a-zA-Z]+)"/g)) exact.add(m[1])
  for (const m of code.matchAll(/message\.StartsWith\("([a-zA-Z]+):"\)/g)) prefixes.add(m[1])
  return { exact: [...exact], prefixes: [...prefixes] }
}

/** 页面字面量被外壳识别 = 精确命令，或命中某个前缀（'setEnvMode:windows' → 前缀 setEnvMode）。 */
const coveredByShell = (literal, shell) =>
  shell.exact.includes(literal)
  || shell.prefixes.some((p) => literal === p + ':' || literal.startsWith(p + ':'))

/** 外壳命令有发送方 = 页面字面量直接覆盖（精确或前缀），或 C# 注入脚本发送（见白名单）。 */
const coveredByPage = (cmd, pageLiterals) =>
  pageLiterals.some((l) => l === cmd || l.startsWith(cmd + ':') || l === cmd + ':')

// C# 侧主动发送（非页面发送）的命令——白名单必须与 Main.cs 实际注入脚本逐条对应：
//   ai            BuildApiIntegrationScript：EXE 渠道把对话轮转发给 C#（qa7 实测覆盖）
//   listSkills / listMcp：外壳引导注入（Main.cs ExecuteScriptAsync 启动拉取）
//   updatePanel：与 installPanel 同分支保留（页面实发 installPanel；updatePanel 为兼容别名）
//   注：installPanel 已有页面发送方（自检页「官方 Skill/MCP 面板」行内按钮，审计修复接入）。
//   v1.1 桌面壳审计（PC22）：openPanelPage / addSkill 死处理器已从 Main.cs 删除，白名单同步移除。
const SHELL_ONLY_ALLOWLIST = ['ai', 'listSkills', 'listMcp', 'updatePanel']

describe('postMessage 命令契约：页面 → 外壳（无死发送）', () => {
  const shell = extractShellCommands(mainCs)
  const pageLiterals = extractPageCommands(pageScript)

  it('抽取器负向不变量：每个发送调用行都被已知形态覆盖（新间接层必须显式登记）', () => {
    const isComment = (l) => { const t = l.trim(); return t.startsWith('*') || t.startsWith('//') }
    const unknown = pageScript.split('\n')
      .filter((l) => !isComment(l) && (l.includes('postMessage(') || /postPluginOp\(|postOrToast\(|\bmk\('/.test(l)))
      .filter((l) => {
        const known = new RegExp(`(postMessage|postPluginOp|postOrToast|mk)\\(${Q}`, '').test(l) // 字面量直发/包装器字面量调用
          || /^function\s+(postPluginOp|postOrToast|bind|mk)\s*\(/.test(l.trim())                 // 包装器定义行（形参非字面量）
          || /postMessage\(\s*\(/.test(l)                                                        // 三元前缀（postMessage）
          || /postMessage\(msg\)/.test(l)                                                        // 包装器体转发
          || new RegExp(`\\?\\s*${Q}`).test(l)                                                    // 包装器上的三元前缀
        return !known
      })
    expect(unknown, `出现未识别的发送形态（请同步更新抽取器）：\n${unknown.join('\n')}`).toEqual([])
  })

  it('两侧命令集抽取非空（解析器未失效）', () => {
    expect(shell.exact.length).toBeGreaterThan(10)
    expect(shell.prefixes.length).toBeGreaterThan(5)
    expect(pageLiterals.length).toBeGreaterThan(20)
  })

  it('页面发送的每条命令都被外壳 WebMessageReceived 识别', () => {
    const dead = pageLiterals.filter((l) => !coveredByShell(l, shell))
    expect(dead, `页面死发送：${dead.join(', ')}`).toEqual([])
  })

  it('核心命令在两侧成对出现（抽样锚点：窗口控制/主题/插件/AI/环境）', () => {
    for (const cmd of ['winMin', 'winMax', 'winClose', 'launch', 'restartHarness', 'harnessStop', 'openApiConfig', 'chooseHarness', 'repairConfig', 'checkPlugins', 'updateAllPlugins', 'listPlugins', 'recheck', 'installHarness', 'autoInstallEnv']) {
      expect(shell.exact, `外壳缺 ${cmd}`).toContain(cmd)
      expect(coveredByPage(cmd, pageLiterals), `页面无 ${cmd} 发送方`).toBe(true)
    }
    for (const p of ['themeBg', 'setEnvMode', 'aiTest', 'updatePlugin', 'addPlugin', 'deletePlugin', 'enablePlugin', 'disablePlugin', 'saveMemory', 'deleteMemory', 'deleteSkill', 'enableSkill', 'disableSkill', 'addSkillSource', 'addMcp', 'deleteMcp', 'enableMcp', 'disableMcp', 'startMcp']) {
      expect(shell.prefixes, `外壳缺前缀 ${p}:`).toContain(p)
      expect(pageLiterals.some((l) => l.startsWith(p + ':')), `页面无前缀 ${p}: 发送方`).toBe(true)
    }
  })
})

describe('postMessage 命令契约：外壳 → 发送方（无孤儿处理器）', () => {
  const shell = extractShellCommands(mainCs)
  const pageLiterals = extractPageCommands(pageScript)

  it('外壳处理的每条命令都有发送方（页面 / C# 注入 / 显式白名单）', () => {
    const orphans = [...shell.exact, ...shell.prefixes].filter(
      (cmd) => !coveredByPage(cmd, pageLiterals) && !SHELL_ONLY_ALLOWLIST.includes(cmd),
    )
    expect(orphans, `无发送方的外壳命令：${orphans.join(', ')}`).toEqual([])
  })

  it('白名单与实际严丝合缝（少一条=该清理未清理，多一条=契约已漂移）', () => {
    const actual = [...shell.exact, ...shell.prefixes].filter(
      (cmd) => !coveredByPage(cmd, pageLiterals),
    ).sort()
    expect(actual.sort(), 'SHELL_ONLY_ALLOWLIST 需与 Main.cs 实际对齐').toEqual([...SHELL_ONLY_ALLOWLIST].sort())
  })

  it('ai: 命令确实由 C# 注入脚本发送（BuildApiIntegrationScript，qa7 实测覆盖）', () => {
    expect(mainCs).toMatch(/postMessage\('ai:'\+/)
  })
})
