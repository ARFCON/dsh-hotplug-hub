// test/ai.test.mjs — AI 装配间（lib/core/ai.js）全分支单测（mock fetch，零网络）
// 覆盖：JSON 提取（纯文本/代码围栏/说明文字/坏 JSON）、成功路径（权威校验通过 +
// README 生成）、产物不合规重试、非 JSON 重试、网络/TLS 错误、HTTP 错误（key 脱敏）、
// 无 key、空需求/超长、重试后成功、解析异常、多平台 provider 解析（deepseek/
// opencode/自定义端点/TLS 铁律）、人设注册表（4 人设/默认女仆/prompt 注入/情绪价值
// 祝贺）、diffPacks、aiChat 会话（首轮装配/对话轮增量修改/纯文本回复/续接/持久化/
// key 零落盘）、gateway.aiChat RPC 面。key 零落盘零打印断言。
// 会话持久化写 hotplugRoot()/ai-sessions —— 全部用例经 helpers 隔离 DSH_HOME（P5）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  aiAssemble, aiChat, extractJson, buildReadme, AI_MAX_RETRIES, AI_PROVIDERS, resolveAiProvider, callCompletions,
  PERSONAS, DEFAULT_PERSONA, buildSystemPrompt, diffPacks, personaReaction, resolvePersona,
} from '../lib/core/ai.js'
import { saveSession, loadSession, trimMessages, sessionsDir, listSessions, sessionPath, deleteSession } from '../lib/core/ai-session.js'
import { HotplugGateway, RPC_ERROR_CODE } from '../lib/gateway.js'
import { isolatedDsh, applyIsolatedEnv } from './helpers.mjs'

const VALID_PACK = {
  hotpack: '1.0',
  id: 'pack.ai.test',
  name: '测试包',
  version: '0.1.0',
  description: 'd',
  tags: ['测试'],
  plugins: [
    { id: 'note', name: 'dsh-notes', version: '1.0.0', source: { type: 'npm' }, config: {} },
  ],
}

/** 构造 fetch 桩（Response 兼容形态：ok/status/text/json/arrayBuffer）。 */
function stubFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const r = await handler(url, init)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.text,
      json: async () => JSON.parse(r.text),
      // 精确切片：小 Buffer 来自共享池，.buffer 是整池（8192B）
      arrayBuffer: async () => {
        const b = Buffer.from(r.text, 'utf8')
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      },
    }
  }
  vi.stubGlobal('fetch', impl)
  return calls
}

let restoreEnv = null
let iso = null

beforeEach(() => {
  // 会话持久化（aiChat/gateway 用例）写 hotplugRoot()/ai-sessions —— 必须隔离
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_DEEPSEEK_API_KEY
  delete process.env.DSH_OPENCODE_API_KEY
  delete process.env.DSH_AI_API_KEY
  delete process.env.DSH_AI_BASE_URL
  delete process.env.DSH_AI_MODEL
  delete process.env.DSH_AI_PROVIDER
  if (restoreEnv) restoreEnv()
  if (iso) iso.cleanup()
})

const KEY = 'sk-test-secret'

describe('resolveAiProvider（多平台解析）', () => {
  it('内置 deepseek：默认 provider，key 读 DSH_DEEPSEEK_API_KEY', () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY
    const r = resolveAiProvider({})
    expect(r.ok).toBe(true)
    expect(r.provider).toBe('deepseek')
    expect(r.baseURL).toBe(AI_PROVIDERS.deepseek.baseURL)
    expect(r.model).toBe(AI_PROVIDERS.deepseek.model)
    expect(r.apiKey).toBe(KEY)
  })
  it('内置 opencode：baseURL 指向 OpenCode Go，模型 deepseek-v4-flash（不带前缀，实测口径），key 读 DSH_OPENCODE_API_KEY', () => {
    process.env.DSH_OPENCODE_API_KEY = KEY
    const r = resolveAiProvider({ provider: 'opencode' })
    expect(r.ok).toBe(true)
    expect(r.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(r.model).toBe('deepseek-v4-flash')
    expect(r.apiKey).toBe(KEY)
  })
  it('内置注册表覆盖主流厂商（OpenRouter/硅基流动/Moonshot/智谱/MiniMax）', () => {
    for (const [name, def] of Object.entries(AI_PROVIDERS)) {
      expect(def.baseURL, name).toMatch(/^https:\/\//)
      expect(typeof def.model, name).toBe('string')
      expect(def.model.length > 0, name).toBe(true)
      expect(def.envKey, name).toMatch(/^DSH_/)
    }
    expect(AI_PROVIDERS.openrouter.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(AI_PROVIDERS.siliconflow.baseURL).toBe('https://api.siliconflow.cn/v1')
    expect(AI_PROVIDERS.moonshot.baseURL).toBe('https://api.moonshot.cn/v1')
    expect(AI_PROVIDERS.zhipu.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(AI_PROVIDERS.minimax.baseURL).toBe('https://api.minimaxi.com/v1')
  })
  it('通用 env 覆盖（DSH_AI_BASE_URL/DSH_AI_MODEL/DSH_AI_API_KEY）', () => {
    process.env.DSH_AI_API_KEY = KEY
    process.env.DSH_AI_BASE_URL = 'https://custom.example.com/v1'
    process.env.DSH_AI_MODEL = 'custom-model'
    const r = resolveAiProvider({})
    expect(r.ok).toBe(true)
    expect(r.baseURL).toBe('https://custom.example.com/v1')
    expect(r.model).toBe('custom-model')
  })
  it('显式参数优先于 env 与注册表', () => {
    process.env.DSH_AI_MODEL = 'env-model'
    const r = resolveAiProvider({ provider: 'opencode', baseURL: 'https://x.example.com/', model: 'explicit', apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.baseURL).toBe('https://x.example.com') // 尾部斜杠归一
    expect(r.model).toBe('explicit')
    expect(r.provider).toBe('opencode')
  })
  it('无 key → 失败（提示对应 env 变量）', () => {
    const r = resolveAiProvider({})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('API Key')
  })
  it('未知 provider 且无 baseURL → 失败', () => {
    const r = resolveAiProvider({ provider: 'unknown-xyz', apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Base URL')
  })
  it('TLS 铁律：非 https baseURL 拒绝', () => {
    const r = resolveAiProvider({ provider: 'deepseek', baseURL: 'http://insecure.example.com', apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('https')
  })
  it('缺模型名（无注册表兜底）→ 失败', () => {
    const r = resolveAiProvider({ provider: 'custom', baseURL: 'https://x.example.com', apiKey: KEY, model: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模型')
  })
})

describe('AI_PROVIDERS 注册表', () => {
  it('deepseek 与 opencode 均指向 OpenAI 兼容端点', () => {
    expect(AI_PROVIDERS.deepseek.baseURL).toMatch(/^https:\/\//)
    expect(AI_PROVIDERS.opencode.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(AI_PROVIDERS.opencode.model).toBe('deepseek-v4-flash')
  })
})

describe('extractJson（LLM 响应提取）', () => {
  it('纯 JSON 文本', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('```json 代码围栏', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('带说明文字（首尾）', () => {
    expect(extractJson('好的，这是清单：\n{"a":1}\n希望有帮助。')).toEqual({ a: 1 })
  })
  it('空/坏 JSON → null', () => {
    expect(extractJson('')).toBeNull()
    expect(extractJson('   ')).toBeNull()
    expect(extractJson('not json at all')).toBeNull()
    expect(extractJson('{"a":')).toBeNull()
    expect(extractJson(null)).toBeNull()
    expect(extractJson(42)).toBeNull()
  })
})

describe('buildReadme', () => {
  it('包含包名、插件清单与安装步骤', () => {
    const pack = {
      name: '测试包',
      plugins: [{ id: 'n', name: 'pkg-a', version: '1.2.3' }],
    }
    const md = buildReadme(pack, '需求描述')
    expect(md).toContain('# 测试包')
    expect(md).toContain('需求描述')
    expect(md).toContain('pkg-a@1.2.3')
    expect(md).toContain('## 安装')
  })
})

describe('aiAssemble（mock fetch）', () => {
  it('成功：LLM 产物通过权威校验，返回 pack/readme，请求头携带 key 但结果不含 key', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiAssemble('做笔记', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.pack.id).toBe('pack.ai.test')
    expect(r.pack.plugins).toHaveLength(1)
    expect(r.readme).toContain('测试包')
    expect(r.manifest).toEqual(VALID_PACK)
    // 请求头带 key（Authorization: Bearer），但结果对象不含 key
    expect(calls[0].init.headers.Authorization).toBe('Bearer ' + KEY)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('成功：环境变量 DSH_DEEPSEEK_API_KEY 缺省 key（不传 opts.apiKey）', async () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiAssemble('做笔记')
    expect(r.ok).toBe(true)
    expect(calls[0].init.headers.Authorization).toBe('Bearer ' + KEY)
  })

  it('多平台：provider=opencode 请求 OpenCode Go 端点与 deepseek-v4-flash 模型', async () => {
    process.env.DSH_OPENCODE_API_KEY = KEY
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiAssemble('做笔记', { provider: 'opencode' })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    const body = JSON.parse(calls[0].init.body)
    expect(body.model).toBe('deepseek-v4-flash')
    expect(calls[0].init.headers.Authorization).toBe('Bearer ' + KEY)
    // key 不出现在任何结果字段
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('多平台：任意内置厂商一键接入（如 Moonshot）', async () => {
    process.env.DSH_MOONSHOT_API_KEY = KEY
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiAssemble('做笔记', { provider: 'moonshot' })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe('https://api.moonshot.cn/v1/chat/completions')
    expect(JSON.parse(calls[0].init.body).model).toBe('kimi-k2')
  })

  it('多平台：自定义 baseURL/model 直连任意 OpenAI 兼容端点', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiAssemble('做笔记', { baseURL: 'https://custom.example.com/v1', model: 'my-model', apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe('https://custom.example.com/v1/chat/completions')
    expect(JSON.parse(calls[0].init.body).model).toBe('my-model')
  })

  it('TLS 铁律：非 https baseURL 拒绝（不经网络）', async () => {
    let called = false
    stubFetch(async () => { called = true; return { status: 200, text: '{}' } })
    const r = await aiAssemble('做笔记', { baseURL: 'http://insecure.example.com', model: 'm', apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('https')
    expect(called).toBe(false)
  })

  it('callCompletions 直调：endpoint/model 透传', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }) }))
    const r = await callCompletions(KEY, 'prompt', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm1' })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('{"a":1}')
    expect(calls[0].url).toBe('https://e.example.com/v1/chat/completions')
    expect(JSON.parse(calls[0].init.body).model).toBe('m1')
  })

  it('厂商差异自适应：temperature 被拒（only 1 allowed）→ temperature=1 自动重试成功', async () => {
    let n = 0
    const calls = stubFetch(async (_url, init) => {
      n += 1
      const body = JSON.parse(init.body)
      if (n === 1) {
        expect(body.temperature).toBe(0.3)
        return { status: 400, text: '{"error":{"message":"invalid temperature: only 1 is allowed for this model"}}' }
      }
      expect(body.temperature).toBe(1)
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }
    })
    const r = await aiAssemble('做笔记', { apiKey: KEY, baseURL: 'https://x.example.com', model: 'temp-strict' })
    expect(r.ok).toBe(true)
    expect(n).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('温度自适应重试仍失败 → 错误包含两次信息且不含 key', async () => {
    stubFetch(async () => ({ status: 400, text: '{"error":{"message":"invalid temperature: only 1 is allowed"}}' }))
    const r = await aiAssemble('做笔记', { apiKey: KEY, baseURL: 'https://x.example.com', model: 'temp-strict' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('temperature=1 重试仍失败')
    expect(r.error).not.toContain(KEY)
  })

  it('产物 plugins 为空 → 权威校验拒绝 → 重试后仍失败（含错误与片段）', async () => {
    let n = 0
    stubFetch(async () => {
      n += 1
      const bad = { ...VALID_PACK, plugins: [] }
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(bad) } }] }) }
    })
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(n).toBe(AI_MAX_RETRIES + 1) // 初次 + 重试
    expect(r.error).toContain('plugins 必须是非空数组')
    expect(r.error).not.toContain(KEY)
  })

  it('输出非 JSON → 重试后失败', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '这是一段说明文字，没有 JSON' } }] }) }))
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不是合法 JSON')
  })

  it('第一次坏产物、第二次好产物 → 重试成功', async () => {
    let n = 0
    stubFetch(async () => {
      n += 1
      const content = n === 1 ? 'no json here' : JSON.stringify(VALID_PACK)
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) }
    })
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(n).toBe(2)
  })

  it('网络/TLS 错误 → 失败（消息不含 key）', async () => {
    stubFetch(async () => { throw new Error('fetch failed: ECONNREFUSED') })
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('网络/TLS 错误')
    expect(r.error).not.toContain(KEY)
  })

  it('HTTP 错误 → 失败且响应体脱敏（key 替换为 ***）', async () => {
    stubFetch(async () => ({ status: 401, text: `unauthorized ${KEY} in body` }))
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 401')
    expect(r.error).not.toContain(KEY)
    expect(r.error).toContain('***')
  })

  it('响应缺少 content → 失败', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: {} }] }) }))
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('choices[0].message.content')
  })

  it('响应体过大（>1MB）→ 失败', async () => {
    stubFetch(async () => ({ status: 200, text: 'x'.repeat((1 << 20) + 1) }))
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('响应过大')
  })

  it('无 key（参数与 env 均缺）→ 失败', async () => {
    const r = await aiAssemble('x')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('API Key')
  })

  it('空需求/空白 → 失败；超长 → 失败', async () => {
    expect((await aiAssemble('', { apiKey: KEY })).error).toContain('不能为空')
    expect((await aiAssemble('   ', { apiKey: KEY })).error).toContain('不能为空')
    expect((await aiAssemble('x'.repeat(4001), { apiKey: KEY })).error).toContain('过长')
  })

  it('响应 JSON 解析异常（非法 JSON 响应体）→ 失败', async () => {
    stubFetch(async () => ({ status: 200, text: 'not-json-response' }))
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('解析失败')
  })

  it('超时（abort）→ 网络错误分支失败', async () => {
    stubFetch(async (_url, init) => {
      // 模拟 abort：signal 被触发时抛 AbortError
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
      })
    })
    const r = await aiAssemble('x', { apiKey: KEY, timeoutMs: 10 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('网络/TLS 错误')
  })

  it('LLM 产物字段越界（非法插件 id/name/version）→ 权威校验拒绝', async () => {
    const bad = {
      ...VALID_PACK,
      plugins: [{ id: 'BAD ID!', name: '../evil', version: 'latest', source: { type: 'npm' } }],
    }
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(bad) } }] }) }))
    const r = await aiAssemble('x', { apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未通过校验')
  })
})

describe('PERSONAS 人设注册表（装配间）', () => {
  it('4 个人设齐全且字段完整', () => {
    expect(Object.keys(PERSONAS).sort()).toEqual(['assistant', 'butler', 'maid', 'neko'])
    for (const [id, p] of Object.entries(PERSONAS)) {
      expect(p.id).toBe(id)
      expect(typeof p.name).toBe('string')
      expect(p.name.length > 0).toBe(true)
      expect(typeof p.emoji).toBe('string')
      expect(typeof p.systemPrompt).toBe('string')
      // 人设基调必须含情绪价值准则（成功祝贺/失败安慰/重试鼓励）
      expect(p.systemPrompt.length, id).toBeGreaterThan(100)
    }
  })

  it('默认女仆「小织」：称呼主人、织布隐喻、情绪价值准则', () => {
    expect(DEFAULT_PERSONA).toBe('maid')
    expect(PERSONAS.maid.name).toBe('小织女仆')
    expect(PERSONAS.maid.systemPrompt).toContain('主人')
    expect(PERSONAS.maid.systemPrompt).toContain('织')
    expect(PERSONAS.maid.systemPrompt).toContain('情绪价值准则')
  })

  it('resolvePersona：未知 id 回退标准助手，空值用默认女仆', () => {
    expect(resolvePersona('maid').id).toBe('maid')
    expect(resolvePersona('butler').id).toBe('butler')
    expect(resolvePersona('neko').id).toBe('neko')
    expect(resolvePersona('assistant').id).toBe('assistant')
    expect(resolvePersona('unknown-xyz').id).toBe('assistant')
    expect(resolvePersona('').id).toBe('maid')
    expect(resolvePersona(undefined).id).toBe('maid')
  })

  it('buildSystemPrompt：组装模式只出 JSON；对话模式允许闲聊；人设注入', () => {
    const asm = buildSystemPrompt('maid', 'assembly')
    expect(asm).toContain('小织')
    expect(asm).toContain('主人')
    expect(asm).toContain('【组装模式】')
    expect(asm).toContain('只输出一个 JSON 对象')
    expect(asm).toContain('hotpack')
    const chat = buildSystemPrompt('neko', 'chat')
    expect(chat).toContain('【对话模式】')
    expect(chat).toContain('正常对话回复')
    expect(chat).toContain('喵')
  })

  it('personaReaction：各人设成功祝贺含包名与插件数', () => {
    const pack = { name: '测试包', plugins: [{ id: 'a' }, { id: 'b' }] }
    expect(personaReaction(PERSONAS.maid, 'success', pack)).toContain('织好啦')
    expect(personaReaction(PERSONAS.maid, 'success', pack)).toContain('测试包')
    expect(personaReaction(PERSONAS.maid, 'success', pack)).toContain('2 个插件')
    expect(personaReaction(PERSONAS.butler, 'success', pack)).toContain('先生')
    expect(personaReaction(PERSONAS.neko, 'success', pack)).toContain('喵')
    expect(personaReaction(PERSONAS.assistant, 'success', pack)).toContain('装配完成')
  })
})

describe('diffPacks（增量差异）', () => {
  it('新增/移除/调整/保持 分类正确（按插件 id 匹配）', () => {
    const oldP = { plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', config: {} },
      { id: 'b', name: 'pkg-b', version: '1.0.0', config: {} },
      { id: 'c', name: 'pkg-c', version: '1.0.0', config: {} },
    ] }
    const newP = { plugins: [
      { id: 'a', name: 'pkg-a', version: '1.0.0', config: {} },
      { id: 'b', name: 'pkg-b', version: '2.0.0', config: {} },
      { id: 'd', name: 'pkg-d', version: '1.0.0', config: {} },
    ] }
    const d = diffPacks(oldP, newP)
    expect(d.added.map((p) => p.id)).toEqual(['d'])
    expect(d.removed.map((p) => p.id)).toEqual(['c'])
    expect(d.changed.map((c) => c.id)).toEqual(['b'])
    expect(d.changed[0].from.version).toBe('1.0.0')
    expect(d.changed[0].to.version).toBe('2.0.0')
    expect(d.kept.map((p) => p.id)).toEqual(['a'])
  })

  it('旧产物为空 → 全部新增；config 变化 → 记调整', () => {
    const d = diffPacks(null, { plugins: [{ id: 'a', name: 'x', version: '1.0.0' }] })
    expect(d.added).toHaveLength(1)
    expect(d.removed).toHaveLength(0)
    const d2 = diffPacks(
      { plugins: [{ id: 'a', name: 'x', version: '1.0.0', config: { k: 1 } }] },
      { plugins: [{ id: 'a', name: 'x', version: '1.0.0', config: { k: 2 } }] },
    )
    expect(d2.changed).toHaveLength(1)
    expect(d2.kept).toHaveLength(0)
  })
})

describe('aiChat（人设化对话式装配）', () => {
  it('首轮：需求 → 装配 → 建会话（persist），reply 带人设祝贺，diff 全部新增', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiChat('做笔记', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.firstTurn).toBe(true)
    expect(r.session.id).toMatch(/^ai-/)
    expect(r.session.turn).toBe(1)
    expect(r.session.persona).toBe('maid')
    expect(r.pack.id).toBe('pack.ai.test')
    expect(r.reply).toContain('织好啦')
    expect(r.diff.added).toHaveLength(1)
    expect(r.diff.removed).toHaveLength(0)
    // system prompt 带人设（小织女仆）
    const body = JSON.parse(calls[0].init.body)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('小织')
    expect(body.messages[0].content).toContain('主人')
    // 会话已落盘且不含 key
    const saved = loadSession(r.session.id)
    expect(saved).not.toBeNull()
    expect(JSON.stringify(saved)).not.toContain(KEY)
  })

  it('第二轮回合：续接会话，LLM 收到人设+历史+当前 pack 上下文，产物 diff 正确', async () => {
    const packB = {
      ...VALID_PACK,
      plugins: [...VALID_PACK.plugins, { id: 'extra', name: 'dsh-extra', version: '2.0.0', source: { type: 'npm' }, config: {} }],
    }
    let n = 0
    const calls = stubFetch(async () => {
      n += 1
      const content = n === 1 ? JSON.stringify(VALID_PACK) : JSON.stringify(packB)
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) }
    })
    const first = await aiChat('做笔记', { apiKey: KEY })
    expect(first.ok).toBe(true)
    const r = await aiChat('再加一个全文搜索插件', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(true)
    expect(r.firstTurn).toBe(false)
    expect(r.session.id).toBe(first.session.id)
    expect(r.session.turn).toBe(2)
    expect(r.pack.plugins).toHaveLength(2)
    expect(r.diff.added.map((p) => p.id)).toEqual(['extra'])
    expect(r.session.pack.plugins).toHaveLength(2)
    // 第二次请求体：system 对话模式 + 历史含首轮需求 + 最新指令带当前 pack 上下文
    expect(calls.length).toBe(2)
    const second = JSON.parse(calls[1].init.body)
    expect(second.messages[0].content).toContain('【对话模式】')
    const lastUser = second.messages[second.messages.length - 1].content
    expect(lastUser).toContain('当前已装配的 hotpack 1.0 清单')
    expect(lastUser).toContain('pack.ai.test')
    expect(lastUser).toContain('再加一个全文搜索插件')
    expect(second.messages.some((m) => m.role === 'user' && m.content.includes('做笔记'))).toBe(true)
    // 会话文件更新且不含 key
    expect(JSON.stringify(loadSession(first.session.id))).not.toContain(KEY)
  })

  it('对话轮纯文本（无 JSON）→ reply 原样透传、产物不变', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '主人，这些插件很适合记笔记呢～' } }] }) }))
    const r = await aiChat('为什么选这个插件？', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(true)
    expect(r.reply).toBe('主人，这些插件很适合记笔记呢～')
    expect(r.pack).toBeNull()
    expect(r.diff).toBeNull()
    expect(r.session.pack.id).toBe('pack.ai.test')
  })

  it('对话轮输出坏产物（plugins 空）→ 按纯文本回复处理，不覆盖既有产物', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...VALID_PACK, plugins: [] }) } }] }) }))
    const r = await aiChat('精简一下', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(true)
    expect(r.pack).toBeNull()
    expect(r.session.pack.plugins).toHaveLength(1)
  })

  it('首轮坏产物重试后成功（沿用重试语义）', async () => {
    let n = 0
    stubFetch(async () => {
      n += 1
      const content = n === 1 ? 'no json here' : JSON.stringify(VALID_PACK)
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) }
    })
    const r = await aiChat('做笔记', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(n).toBe(2)
  })

  it('指定人设（neko/butler）注入 system prompt 与祝贺语', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiChat('做笔记', { apiKey: KEY, persona: 'neko' })
    expect(r.ok).toBe(true)
    expect(r.reply).toContain('喵')
    expect(JSON.parse(calls[0].init.body).messages[0].content).toContain('咪咪')
    const r2 = await aiChat('做笔记', { apiKey: KEY, persona: 'butler' })
    expect(r2.ok).toBe(true)
    expect(r2.reply).toContain('先生')
  })

  it('会话持久化：续接时 persona 沿用会话记录（新 persona 参数不覆盖）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY, persona: 'neko' })
    expect(first.session.persona).toBe('neko')
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '喵呜～好的主人喵' } }] }) }))
    const r = await aiChat('好的', { apiKey: KEY, sessionId: first.session.id, persona: 'butler' })
    expect(r.ok).toBe(true)
    expect(r.session.persona).toBe('neko') // 会话已有 persona 时以会话为准
  })

  it('key 绝不落盘/绝不回显：会话文件与响应（含历史与用户输入）无 key', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const r = await aiChat('做笔记', { apiKey: KEY })
    expect(JSON.stringify(r)).not.toContain(KEY)
    const file = join(sessionsDir(), r.session.id + '.json')
    expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))).not.toContain(KEY)
    // 用户消息里误贴 key → 响应历史脱敏
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '收到' } }] }) }))
    const r2 = await aiChat('我的 key 是 ' + KEY + ' 请记住', { apiKey: KEY, sessionId: r.session.id })
    expect(JSON.stringify(r2)).not.toContain(KEY)
    expect(JSON.stringify(loadSession(r.session.id))).not.toContain(KEY)
  })

  it('saveSession/loadSession/listSessions 往返；不存在返回 null', () => {
    const s = { id: 'ai-test-1', persona: 'maid', messages: [{ role: 'user', content: 'hi' }], pack: null, turn: 1, createdAt: 'x', updatedAt: 'y' }
    expect(saveSession(s)).toBe(true)
    const loaded = loadSession('ai-test-1')
    expect(loaded.id).toBe('ai-test-1')
    expect(loaded.persona).toBe('maid')
    expect(loaded.messages[0].content).toBe('hi')
    expect(loadSession('ai-missing-xyz')).toBeNull()
    expect(loadSession('')).toBeNull()
    expect(listSessions().some((x) => x.id === 'ai-test-1')).toBe(true)
  })

  it('会话存储防御：无效 id / 损坏 JSON / 路径穿越清洗 / 删除', () => {
    expect(saveSession(null)).toBe(false)
    expect(saveSession({})).toBe(false)
    // 损坏 JSON → null（不抛）
    const dir = sessionsDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ai-broken.json'), '{not json', 'utf8')
    expect(loadSession('ai-broken')).toBeNull()
    // 路径穿越：sessionId 含 ../ 或分隔符现被「拒绝」（返回 null），不再有损清洗
    // （有损清洗非单射：'a/b' 与 'ab' 同文件，会覆盖/误删/读不到——审计修复）
    expect(sessionPath('ai-../../evil')).toBeNull()
    expect(sessionPath('a/b')).toBeNull()
    // 删除：存在与不存在均返回 true 且不抛
    expect(deleteSession('ai-test-1')).toBe(true)
    expect(loadSession('ai-test-1')).toBeNull()
    expect(deleteSession('ai-missing-xyz')).toBe(true)
    expect(deleteSession('')).toBe(false)
    // 空目录列表
    expect(listSessions().length).toBe(0)
  })

  it('trimMessages：条数上限 + 单条截断 + role 白名单', () => {
    const msgs = []
    for (let i = 0; i < 30; i += 1) msgs.push({ role: 'user', content: 'x'.repeat(5000) })
    const t = trimMessages(msgs)
    expect(t.length).toBeLessThanOrEqual(16)
    expect(t[0].content.length).toBeLessThanOrEqual(3000)
    const bad = trimMessages([{ role: 'admin', content: 'hack' }])
    expect(bad[0].role).toBe('user')
    expect(trimMessages(null)).toEqual([])
  })
})

describe('gateway.aiChat（RPC 面）', () => {
  it('成功返回 {ok, code:OK, data:{session, reply, pack, diff, firstTurn}}，无 key', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const r = await gateway.aiChat({ input: '做笔记', apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('OK')
    expect(r.data.session.id).toMatch(/^ai-/)
    expect(r.data.session.turn).toBe(1)
    expect(r.data.reply).toContain('织好啦')
    expect(r.data.pack.id).toBe('pack.ai.test')
    expect(r.data.readme).toContain('测试包')
    expect(r.data.diff.added).toHaveLength(1)
    expect(r.data.firstTurn).toBe(true)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('无 key → 失败归一化 {ok:false, code:ERR_HOTPLUG_FAILED, message 含 API Key}', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const r = await gateway.aiChat({ input: '做笔记' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(RPC_ERROR_CODE)
    expect(r.message).toContain('API Key')
  })

  it('会话续接：两次 aiChat 调用返回同一会话 id', async () => {
    let n = 0
    stubFetch(async () => {
      n += 1
      const content = n === 1 ? JSON.stringify(VALID_PACK) : JSON.stringify({ ...VALID_PACK, plugins: [...VALID_PACK.plugins, { id: 'e', name: 'dsh-e', version: '1.0.0', source: { type: 'npm' }, config: {} }] })
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) }
    })
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const first = await gateway.aiChat({ input: '做笔记', apiKey: KEY })
    const second = await gateway.aiChat({ input: '加一个插件', apiKey: KEY, sessionId: first.data.session.id })
    expect(second.ok).toBe(true)
    expect(second.data.session.id).toBe(first.data.session.id)
    expect(second.data.session.turn).toBe(2)
    expect(second.data.diff.added).toHaveLength(1)
    expect(second.data.firstTurn).toBe(false)
  })
})
