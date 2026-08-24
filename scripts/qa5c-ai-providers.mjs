#!/usr/bin/env node
/**
 * qa5c-ai-providers.mjs — AI 装配间多供应商矩阵真实链路 QA
 *
 * 目标：同一套产品代码（lib/core/ai.js + gateway）在多个真实 OpenAI 兼容供应商/
 * 模型上验证四件事——连接测试（aiTest）、首轮装配（权威校验产物）、对话式修改
 * （diff）、闲聊轮（产物不被 LLM 违规 JSON 覆盖——等价守卫）。
 *
 * 内置矩阵（按存在的 env key 自动启用，缺 key 跳过该行并提示）：
 *   - opencode    https://opencode.ai/zen/go/v1   deepseek-v4-flash   DSH_OPENCODE_API_KEY
 *   - deepseek    https://api.deepseek.com        deepseek-chat       DSH_DEEPSEEK_API_KEY
 *   - deepseek    https://api.deepseek.com        deepseek-reasoner   DSH_DEEPSEEK_API_KEY
 *   - tokenrhythm https://tokenrhythm.studio/v1   deepseek-v4-flash   DSH_TOKENRHYTHM_API_KEY
 *   - tokenrhythm https://tokenrhythm.studio/v1   glm-5.2             DSH_TOKENRHYTHM_API_KEY
 *   - tokenrhythm https://tokenrhythm.studio/v1   kimi-k2.6           DSH_TOKENRHYTHM_API_KEY
 * 追加行：DSH_QA5C_MATRIX='[{"provider":"x","baseURL":"https://…/v1","model":"m","envKey":"ENV"}]'
 *
 * 进程隔离铁律（与 qa5/qa5b 同源）：mkdtemp 临时 DSH_HOME + 7 项 env 重定向 +
 * 删除 TLS/Node 注入变量；key 只经 env 注入，绝不打印/落盘；结束整根清理。
 * 真实 LLM 输出不确定：闲聊轮模型若输出“不同清单”记 WARN（提示词违规但产物链路
 * 安全），只有系统行为违约（坏产物被当闲聊/echo 覆盖/会话漂移）才 FAIL。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILTIN_MATRIX = [
  { provider: 'opencode', baseURL: undefined, model: undefined, envKey: 'DSH_OPENCODE_API_KEY' },
  { provider: 'deepseek', baseURL: undefined, model: 'deepseek-chat', envKey: 'DSH_DEEPSEEK_API_KEY' },
  { provider: 'deepseek', baseURL: undefined, model: 'deepseek-reasoner', envKey: 'DSH_DEEPSEEK_API_KEY' },
  { provider: undefined, baseURL: 'https://tokenrhythm.studio/v1', model: 'deepseek-v4-flash', envKey: 'DSH_TOKENRHYTHM_API_KEY' },
  { provider: undefined, baseURL: 'https://tokenrhythm.studio/v1', model: 'glm-5.2', envKey: 'DSH_TOKENRHYTHM_API_KEY' },
  { provider: undefined, baseURL: 'https://tokenrhythm.studio/v1', model: 'kimi-k2.6', envKey: 'DSH_TOKENRHYTHM_API_KEY' },
]

const KEEP_ENV_KEYS = ['DSH_OPENCODE_API_KEY', 'DSH_DEEPSEEK_API_KEY', 'DSH_TOKENRHYTHM_API_KEY', 'DSH_QA5C_MATRIX', 'DSH_QA5C_ONLY']

function isolateEnv(root) {
  const saved = {}
  const overrides = {
    DSH_HOME: root,
    DSH_PROFILE: 'web',
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, 'local'),
    PATH: process.env.PATH,
  }
  for (const k of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'DSH_AI_PROVIDER', 'DSH_AI_BASE_URL', 'DSH_AI_MODEL', 'DSH_AI_API_KEY']) {
    if (k in process.env) { saved[k] = process.env[k]; delete process.env[k] }
  }
  for (const [k, v] of Object.entries(overrides)) { saved[k] = process.env[k]; process.env[k] = v }
  mkdirSync(join(root, 'profiles', 'web', 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', private: true, version: '0.0.0' }))
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

const root = mkdtempSync(join(tmpdir(), 'qa5c-root-'))
const savedKeys = {}
for (const k of KEEP_ENV_KEYS) if (process.env[k] !== undefined) savedKeys[k] = process.env[k]
const restoreEnv = isolateEnv(root)
// 隔离覆盖会动到 HOME 等，但 key 变量不在覆盖表里；显式回填保留的 key
for (const [k, v] of Object.entries(savedKeys)) process.env[k] = v

const { HotplugGateway } = await import('../dsh-hotplug-hub/lib/gateway.js')
const gateway = new HotplugGateway({ reflect: { provide: () => {} } })

let exitCode = 0
const warn = (m) => console.log('  WARN: ' + m)
const fail = (m) => { console.error('  FAIL: ' + m); exitCode = 1 }

function matrixRows() {
  const rows = [...BUILTIN_MATRIX]
  if (process.env.DSH_QA5C_MATRIX) {
    try {
      const extra = JSON.parse(process.env.DSH_QA5C_MATRIX)
      if (Array.isArray(extra)) rows.push(...extra)
    } catch (e) {
      console.error('DSH_QA5C_MATRIX 解析失败：' + e.message)
      exitCode = 2
    }
  }
  return rows
}

const label = (row) => `${row.provider || 'custom'}${row.model ? ':' + row.model : ''}${row.baseURL ? ' @ ' + row.baseURL : ''}`

  // 瞬时错误重试（与 qa5b 同策略）：上游限流/网关超时/模型慢启动是真实链路正常瞬态
  const maxAttempts = Number(process.env.DSH_QA5C_MAX_ATTEMPTS || 3)
  const retryWaitMs = Number(process.env.DSH_QA5C_RETRY_MS || 8000)
  const transient = (r) => /超时|网络\/TLS|HTTP 429|HTTP 5\d\d|Model is unavailable|server_error/i.test((r && (r.message || r.error)) || '')
  const withRetry = async (label, fn) => {
    let r = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      r = await fn()
      if (r.ok) break
      if (attempt < maxAttempts && transient(r)) {
        console.log(`  [${label}] 瞬时错误（${String(r.message ?? r.error).slice(0, 90)}），${retryWaitMs / 1000}s 后重试（${attempt}/${maxAttempts}）…`)
        await new Promise((resolve) => setTimeout(resolve, retryWaitMs))
      } else {
        break
      }
    }
    return r
  }

async function runRow(row) {
  const apiKey = (process.env[row.envKey] || '').trim()
  if (!apiKey) { console.log(`  SKIP（未配置 ${row.envKey}）`); return }
  const params = { apiKey }
  if (row.provider) params.provider = row.provider
  if (row.baseURL) params.baseURL = row.baseURL
  if (row.model) params.model = row.model

  // A. 连接测试
  const test = await withRetry('aiTest', () => gateway.aiTest(params))
  if (!test.ok) { fail(`aiTest：${test.message ?? test.error}`); return }
  console.log(`  [A] 连接 PASS（model=${test.data.model}，${test.data.latencyMs}ms）`)

  // B. 首轮装配
  const r1 = await withRetry('首轮', () => gateway.aiChat({
    input: '帮我组一个做笔记和知识管理的插件包：Markdown 笔记、全文搜索、标签整理',
    ...params,
  }))
  if (!r1.ok) { fail(`首轮装配：${r1.message ?? r1.error}`); return }
  if (!r1.data.pack || !Array.isArray(r1.data.pack.plugins) || r1.data.pack.plugins.length === 0) {
    fail('首轮装配：产物缺 plugins'); return
  }
  console.log(`  [B] 首轮装配 PASS（${r1.data.pack.name}，${r1.data.pack.plugins.length} 插件，turn=${r1.data.session.turn}）`)

  // C. 对话式修改
  const sessionId = r1.data.session.id
  const beforeModify = JSON.stringify(r1.data.pack)
  const r2 = await withRetry('修改轮', () => gateway.aiChat({ input: '再加一个思维导图相关的插件', sessionId, ...params }))
  if (!r2.ok) { fail(`修改轮：${r2.message ?? r2.error}`); return }
  if (r2.data.pack) {
    const d = r2.data.diff || { added: [], removed: [], changed: [] }
    const changed = d.added.length + d.removed.length + d.changed.length
    if (changed === 0 && JSON.stringify(r2.data.pack) === beforeModify) {
      warn('修改轮产物与上一轮完全一致（模型未执行修改指令，产物链路仍一致）')
    } else {
      console.log(`  [C] 修改轮 PASS（新增 ${d.added.length} / 移除 ${d.removed.length} / 调整 ${d.changed.length}）`)
    }
  } else {
    console.log('  [C] 修改轮：纯对话回复（产物未变——模型选择先澄清，链路语义正确）')
  }

  // D. 闲聊轮：产物不得被违规 JSON 意外覆盖（等价守卫：echo → nochange；不同清单 → WARN）
  const beforeChat = JSON.stringify(r2.data.session.pack)
  const r3 = await withRetry('闲聊轮', () => gateway.aiChat({ input: '这些插件为什么要选它们？有什么搭配逻辑吗', sessionId, ...params }))
  if (!r3.ok) { fail(`闲聊轮：${r3.message ?? r3.error}`); return }
  const afterChat = JSON.stringify(r3.data.session.pack)
  if (r3.data.pack === null || r3.data.pack === undefined) {
    console.log(`  [D] 闲聊轮 PASS（纯对话${r3.data.reply && r3.data.reply.includes('一样') ? '，含等价守卫 nochange' : ''}，产物未变）`)
  } else if (afterChat === beforeChat) {
    fail('闲聊轮声称新产物但 session.pack 未更新（状态不一致）')
  } else {
    warn('闲聊轮模型输出了新清单（提示词违规；产物链路安全，session.pack 同步更新）')
  }
  console.log(`      回复片段：${String(r3.data.reply).slice(0, 60).replace(/\n/g, ' ')}…`)
}

async function main() {
  const rows = matrixRows()
  const only = process.env.DSH_QA5C_ONLY
  console.log(`== QA5c AI 装配间多供应商矩阵（${rows.length} 行，隔离根=${root}）==`)
  let ran = 0
  for (const row of rows) {
    const name = label(row)
    if (only && !name.includes(only)) continue
    console.log(`-- ${name}`)
    await runRow(row)
    ran += 1
  }
  if (ran === 0) { console.error('没有任何矩阵行被执行（全部缺 key 或 ONLY 过滤为空）'); exitCode = 2 }
  console.log(exitCode === 0 ? '== QA5c 结果：PASS ==' : '== QA5c 结果：FAIL ==')
}

try {
  await main()
} finally {
  restoreEnv()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 句柄延迟：尽力而为 */ }
  // 不用 process.exit 硬退（undici 定时器竞态，见 qa5 注释）
  process.exitCode = exitCode
}
