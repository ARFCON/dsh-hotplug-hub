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
import { saveSession, loadSession, trimMessages, sessionsDir, listSessions, sessionPath, deleteSession, SESSION_MAX_MESSAGE_CHARS } from '../lib/core/ai-session.js'
import { HotplugGateway, AI_ERROR_CODE } from '../lib/gateway.js'
import { aiTestConnection, AI_MAX_OUTPUT_TOKENS, newSessionId as newSidDirect } from '../lib/core/ai.js'
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
      headers: r.headers, // 透传（429 Retry-After / Content-Length 预检用例）
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

  it('超时（abort）→ 独立超时语义（与网络错误区分，便于判断换模型还是重试）', async () => {
    stubFetch(async (_url, init) => {
      // 模拟 abort：signal 被触发时抛 AbortError
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
      })
    })
    const r = await aiAssemble('x', { apiKey: KEY, timeoutMs: 10 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('超时')
    expect(r.error).not.toContain('网络/TLS')
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

  it('对话轮输出坏产物（plugins 空）→ 纠错重试仍失败 → 本轮失败（不落盘、不把非法 JSON 当闲聊展示）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    const before = loadSession(first.session.id)
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...VALID_PACK, plugins: [] }) } }] }) }))
    const r = await aiChat('精简一下', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未通过校验')
    // 会话不被失败轮污染：turn/pack/消息与失败前一致
    const after = loadSession(first.session.id)
    expect(after.turn).toBe(before.turn)
    expect(after.pack.plugins).toHaveLength(1)
    expect(after.messages.length).toBe(before.messages.length)
  })

  it('对话轮坏产物 → 纠错重试（带失败反馈）成功 → 新产物生效', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    const calls = stubFetch(async () => {
      if (calls.length === 1) {
        return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...VALID_PACK, plugins: [] }) } }] }) }
      }
      const fixed = { ...VALID_PACK, plugins: [...VALID_PACK.plugins, { id: 'search', name: 'dsh-search', version: '1.1.0', source: { type: 'npm' }, config: {} }] }
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixed) } }] }) }
    })
    const r = await aiChat('加一个搜索插件', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(true)
    expect(calls.length).toBe(2) // 失败一次 + 纠错重试一次
    expect(r.pack.plugins).toHaveLength(2)
    expect(r.diff.added).toHaveLength(1)
    // 纠错请求携带失败反馈（assistant 原文 + 纠错指令）
    const retryBody = JSON.parse(calls[1].init.body)
    expect(retryBody.messages.at(-1).content).toContain('校验')
    expect(retryBody.messages.at(-1).content).toContain('ERR_ASSEMBLY_FIELD')
    expect(retryBody.messages.at(-2).role).toBe('assistant')
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

  it('会话持久化：续接时显式 persona 切换会话人设并持久化（缺省沿用会话记录）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY, persona: 'neko' })
    expect(first.session.persona).toBe('neko')
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '喵呜～好的主人喵' } }] }) }))
    // 显式切换：生效并落盘（UI 中途换人设不再被静默忽略/回弹）
    const switched = await aiChat('好的', { apiKey: KEY, sessionId: first.session.id, persona: 'butler' })
    expect(switched.ok).toBe(true)
    expect(switched.session.persona).toBe('butler')
    expect(loadSession(first.session.id).persona).toBe('butler')
    // 缺省：沿用会话记录（刷新恢复/旧客户端不带 persona 参数）
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '遵命' } }] }) }))
    const kept = await aiChat('继续', { apiKey: KEY, sessionId: first.session.id })
    expect(kept.session.persona).toBe('butler')
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

  it('无 key → 失败归一化 {ok:false, code:ERR_AI_ASSEMBLE, message 含 API Key}', async () => {
    const gateway = new HotplugGateway({ reflect: { provide: () => {} } })
    const r = await gateway.aiChat({ input: '做笔记' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(AI_ERROR_CODE)
    expect(r.message).toContain('API Key')
    expect(typeof r.exitCode).toBe('number')
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

describe('extractJson（多围栏与类型守卫）', () => {
  it('多围栏：解释围栏在前、产物围栏在后 → 取产物（最后一个可解析对象围栏）', () => {
    const text = '先说明一下：\n```json\n{"note":"这不是产物"}\n```\n以下是清单：\n```json\n{"hotpack":"1.0"}\n```'
    const v = extractJson(text)
    expect(v).toEqual({ hotpack: '1.0' })
  })

  it('围栏内是数组/数字/字符串 → 不当作产物（全落空返回 null）', () => {
    expect(extractJson('```json\n[1,2,3]\n```')).toBeNull()
    expect(extractJson('```json\n42\n```')).toBeNull()
    expect(extractJson('```json\n"plain"\n```')).toBeNull()
  })

  it('围栏未闭合但尾随裸 JSON 可解析 → 大括号子串兜底生效', () => {
    expect(extractJson('```json\n{"hotpack":"1.0"}')).toEqual({ hotpack: '1.0' })
  })
})

describe('callCompletions（限流/体积/脱敏/参数面）', () => {
  it('429 + Retry-After → 返回 status/retryAfterMs（供上层退避）', async () => {
    stubFetch(async () => ({ status: 429, text: 'rate limited', headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '2' : null) } }))
    const r = await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(429)
    expect(r.retryAfterMs).toBe(2000)
    expect(r.error).toContain('429')
  })

  it('429 无 Retry-After → retryAfterMs undefined，语义仍是限流', async () => {
    stubFetch(async () => ({ status: 429, text: 'rate limited', headers: { get: () => null } }))
    const r = await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm' })
    expect(r.status).toBe(429)
    expect(r.retryAfterMs).toBeUndefined()
  })

  it('HTTP 错误体回显 key 两次 → 全量脱敏（不残留第二次出现）', async () => {
    stubFetch(async () => ({ status: 401, text: `bad ${KEY} and again ${KEY} here` }))
    const r = await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm' })
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain(KEY)
    expect(r.error.split('***').length - 1).toBe(2)
  })

  it('Content-Length 超限 → 预检拒绝，不读响应体', async () => {
    let bodyRead = false
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String((1 << 20) + 1) : null) },
      text: async () => { bodyRead = true; return '' },
      arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0) },
    }))
    const r = await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Content-Length')
    expect(bodyRead).toBe(false)
  })

  it('max_tokens 默认 AI_MAX_OUTPUT_TOKENS（4096），可显式覆盖', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }))
    await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm' })
    expect(JSON.parse(calls[0].init.body).max_tokens).toBe(AI_MAX_OUTPUT_TOKENS)
    expect(AI_MAX_OUTPUT_TOKENS).toBe(4096)
    await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm', maxTokens: 64 })
    expect(JSON.parse(calls[1].init.body).max_tokens).toBe(64)
  })

  it('装配重试带纠错反馈：第二次请求含第一次失败原文与校验错误', async () => {
    let n = 0
    const calls = stubFetch(async () => {
      n += 1
      if (n === 1) return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...VALID_PACK, plugins: [] }) } }] }) }
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }
    })
    const r = await aiAssemble('做笔记', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(calls.length).toBe(2)
    const retryBody = JSON.parse(calls[1].init.body)
    expect(retryBody.messages.at(-1).content).toContain('ERR_ASSEMBLY_FIELD')
    expect(retryBody.messages.at(-2).role).toBe('assistant')
    expect(retryBody.messages.at(-2).content).toContain('plugins')
  })

  it('429 Retry-After ≤5s → 装配轮等待后重试（时间可观测推进）', async () => {
    let n = 0
    let firstAt = 0
    let secondAt = 0
    stubFetch(async () => {
      n += 1
      if (n === 1) { firstAt = Date.now(); return { status: 429, text: 'rate limited', headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.15' : null) } } }
      secondAt = Date.now()
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }
    })
    const r = await aiAssemble('做笔记', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(140) // ≥150ms 退避（容差）
  })
})

describe('aiTestConnection（连接测试核心）', () => {
  it('成功：返回 provider/model/latencyMs；请求体是最小 ping（max_tokens 64）', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) }))
    const r = await aiTestConnection({ apiKey: KEY, provider: 'opencode' })
    expect(r.ok).toBe(true)
    expect(r.provider).toBe('opencode')
    expect(r.model).toBe('deepseek-v4-flash')
    expect(typeof r.latencyMs).toBe('number')
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(JSON.parse(calls[0].init.body).max_tokens).toBe(64)
  })

  it('失败：错误透出且脱敏；无 key → 明确提示', async () => {
    stubFetch(async () => ({ status: 401, text: `bad ${KEY}` }))
    const r = await aiTestConnection({ apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
    expect(r.error).not.toContain(KEY)
    const noKey = await aiTestConnection({})
    expect(noKey.ok).toBe(false)
    expect(noKey.error).toContain('API Key')
  })

  it('非 https 注入端点 → 拒绝（不发起请求）', async () => {
    stubFetch(async () => { throw new Error('must not be called') })
    const r = await aiTestConnection({ apiKey: KEY, endpoint: 'http://insecure.test/chat/completions' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('https')
  })
})

describe('推理类模型兼容（content 为空 / reasoning_content）', () => {
  it('callCompletions 默认严格：content 为空 → 失败（装配路径不受影响）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'thinking...' } }] }) }))
    const r = await callCompletions(KEY, 'x', { endpoint: 'https://e.example.com/v1/chat/completions', model: 'm' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('缺少 choices')
  })

  it('aiTestConnection 宽松：推理模型小预算全花在 reasoning → 连接仍判可用', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: '1. Analyze' } }] }) }))
    const r = await aiTestConnection({ apiKey: KEY, provider: 'zhipu' })
    expect(r.ok).toBe(true)
    expect(r.provider).toBe('zhipu')
  })

  it('aiTestConnection ping 预算 64（普通模型可完整作答，推理模型够思考起步）', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) }))
    await aiTestConnection({ apiKey: KEY })
    expect(JSON.parse(calls[0].init.body).max_tokens).toBe(64)
  })
})

describe('aiChat 请求端点与输入契约', () => {
  it('非 https 测试注入 endpoint → 拒绝（TLS 铁律无旁路）', async () => {
    stubFetch(async () => { throw new Error('must not be called') })
    const r = await aiChat('做笔记', { apiKey: KEY, endpoint: 'http://insecure.test/chat/completions' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('https')
  })

  it('4000 字符需求：当前轮全文进请求（截断只作用于历史落盘形态）', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const long = '需'.repeat(4000)
    const r = await aiChat(long, { apiKey: KEY })
    expect(r.ok).toBe(true)
    const body = JSON.parse(calls[0].init.body)
    const lastUser = body.messages.at(-1)
    expect(lastUser.content).toContain(long)
    expect(lastUser.content.length).toBeGreaterThan(4000)
  })

  it('首轮成功返回 raw（LLM 原文，含围栏）；aiAssemble 的 raw 契约成立', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(VALID_PACK) + '\n```' } }] }) }))
    const r = await aiAssemble('做笔记', { apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(typeof r.raw).toBe('string')
    expect(r.raw).toContain('hotpack')
    expect(r.manifest).toEqual(VALID_PACK)
  })

  it('newSessionId 用 CSPRNG（hex 随机段，格式稳定）', () => {
    expect(newSidDirect()).toMatch(/^ai-[a-z0-9]+-[0-9a-f]{12}$/)
  })
})

describe('闲聊轮等价守卫（echo guard）', () => {
  it('对话轮回显当前清单（内容等价、键序不同）→ 零变更说明，不覆盖产物、不产 diff', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    const packBefore = JSON.stringify(first.session.pack)
    const shuffled = { plugins: VALID_PACK.plugins, tags: VALID_PACK.tags, description: VALID_PACK.description, version: VALID_PACK.version, name: VALID_PACK.name, id: VALID_PACK.id, hotpack: VALID_PACK.hotpack }
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(shuffled) + '\n```' } }] }) }))
    const r = await aiChat('为什么选这些？', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(true)
    expect(r.pack).toBeNull()
    expect(r.diff).toBeNull()
    expect(r.reply).toContain('一样')
    expect(JSON.stringify(r.session.pack)).toBe(packBefore)
    // 回显的 JSON 形态消息标记 kind='pack'（不进下一轮上下文）
    const stored = loadSession(first.session.id)
    expect(stored.messages.at(-1).kind).toBe('pack')
  })

  it('插件仅调序（内容等价）→ 同样按零变更处理（顺序无关等价）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const two = { ...VALID_PACK, plugins: [...VALID_PACK.plugins, { id: 'extra', name: 'dsh-extra', version: '2.0.0', source: { type: 'npm' }, config: {} }] }
    const first = await aiChat('做笔记', { apiKey: KEY })
    expect(first.pack.plugins).toHaveLength(1)
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(two) } }] }) }))
    const second = await aiChat('再加一个', { apiKey: KEY, sessionId: first.session.id })
    expect(second.pack.plugins).toHaveLength(2)
    // 回显同一清单但插件顺序对调 → nochange（不覆盖、无 diff）
    const reordered = { ...two, plugins: [two.plugins[1], two.plugins[0]] }
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reordered) } }] }) }))
    const r = await aiChat('为什么这么选？', { apiKey: KEY, sessionId: first.session.id })
    expect(r.pack).toBeNull()
    expect(r.diff).toBeNull()
    expect(r.session.pack.plugins).toHaveLength(2)
  })

  it('纠错重试成功但回显等价清单 → 同样按零变更处理（守卫覆盖纠错路径）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    // 第一次：坏产物；纠错后：与当前清单等价（键序打乱）
    stubFetch(async (_u, _i, n) => {
      if (n === 1) return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...VALID_PACK, plugins: [] }) } }] }) }
      const shuffled = { plugins: VALID_PACK.plugins, tags: VALID_PACK.tags, id: VALID_PACK.id, hotpack: VALID_PACK.hotpack, name: VALID_PACK.name, version: VALID_PACK.version, description: VALID_PACK.description }
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(shuffled) } }] }) }
    })
    const r = await aiChat('调整一下', { apiKey: KEY, sessionId: first.session.id })
    expect(r.ok).toBe(true)
    expect(r.pack).toBeNull()
    expect(r.reply).toContain('一样')
    expect(r.session.pack.plugins).toHaveLength(1)
  })

  it('plugins 超过 5 个 → AI 层规则拒绝（ERR_AI_RULE 标记，不冒用权威码），纠错后收敛', async () => {
    const tooMany = {
      ...VALID_PACK,
      plugins: Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, name: 'dsh-p' + i, version: '1.0.0', source: { type: 'npm' }, config: {} })),
    }
    stubFetch(async (_u, _i, n) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(n === 1 ? tooMany : VALID_PACK) } }] }) }))
    const r = await aiAssemble('大而全的需求', { apiKey: KEY })
    expect(r.ok).toBe(true) // 纠错重试收敛到 1 插件
    // 全程失败路径的错误信息用 ERR_AI_RULE
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(tooMany) } }] }) }))
    const fail = await aiAssemble('大而全的需求', { apiKey: KEY })
    expect(fail.ok).toBe(false)
    expect(fail.error).toContain('ERR_AI_RULE')
    expect(fail.error).not.toContain('ERR_ASSEMBLY_FIELD plugins 最多')
  })

  it('对话轮输出"不同"合法清单 → 仍按新产物处理（修改协议语义保留）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    const bigger = { ...VALID_PACK, plugins: [...VALID_PACK.plugins, { id: 'extra', name: 'dsh-extra', version: '2.0.0', source: { type: 'npm' }, config: {} }] }
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(bigger) } }] }) }))
    const r = await aiChat('闲聊一句', { apiKey: KEY, sessionId: first.session.id })
    expect(r.pack.plugins).toHaveLength(2)
    expect(r.diff.added).toHaveLength(1)
  })
})

describe('会话级互斥（同 sessionId 并发不丢更新）', () => {
  it('两个并发后续轮 → 串行落盘，两条用户消息与轮次都保留', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    const sid = first.session.id
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '好的主人～' } }] }) }))
    const [a, b] = await Promise.all([
      aiChat('第一条跟进', { apiKey: KEY, sessionId: sid }),
      aiChat('第二条跟进', { apiKey: KEY, sessionId: sid }),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const stored = loadSession(sid)
    expect(stored.turn).toBe(3)
    const userTexts = stored.messages.filter((m) => m.role === 'user').map((m) => m.content)
    expect(userTexts).toContain('第一条跟进')
    expect(userTexts).toContain('第二条跟进')
  })

  it('不同会话并发 → 互不阻塞（各自成功）', async () => {
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const [a, b] = await Promise.all([
      aiChat('需求甲', { apiKey: KEY }),
      aiChat('需求乙', { apiKey: KEY }),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(a.session.id).not.toBe(b.session.id)
  })
})

describe('落盘失败告警（磁盘错误不静默）', () => {
  it('会话文件只读 → 第二轮返回 warning，会话内容仍在响应中可用', async () => {
    const { chmodSync } = await import('node:fs')
    stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_PACK) } }] }) }))
    const first = await aiChat('做笔记', { apiKey: KEY })
    const file = join(sessionsDir(), first.session.id + '.json')
    chmodSync(file, 0o444) // Windows：只读属性 → rename 覆盖失败
    try {
      stubFetch(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '好的～' } }] }) }))
      const r = await aiChat('继续', { apiKey: KEY, sessionId: first.session.id })
      expect(r.ok).toBe(true)
      expect(r.warning).toContain('保存失败')
      expect(r.reply).toBe('好的～')
    } finally {
      chmodSync(file, 0o666)
    }
  })
})

describe('trimMessages（码点安全）', () => {
  it('代理对不被劈开：截断边界不产生孤立代理', () => {
    const emoji = '😀'.repeat(SESSION_MAX_MESSAGE_CHARS + 50) // 每个 emoji 是一个代理对（2 码元）
    const out = trimMessages([{ role: 'user', content: emoji }])
    // 契约按码点数封顶：截到整 3000 个 emoji（6000 码元），不劈开最后一个代理对
    expect(Array.from(out[0].content).length).toBe(SESSION_MAX_MESSAGE_CHARS)
    expect(out[0].content.length).toBe(SESSION_MAX_MESSAGE_CHARS * 2)
    const s = out[0].content
    expect(s.length % 2).toBe(0) // 全由完整代理对构成（无孤立代理）
    const rebuilt = Array.from(s).map((ch) => String.fromCodePoint(ch.codePointAt(0))).join('')
    expect(rebuilt).toBe(s)
  })
})

describe('diffPacks（config 语义）', () => {
  const P = (over = {}) => ({ id: 'p1', name: 'dsh-p1', version: '1.0.0', source: { type: 'npm' }, config: {}, ...over })

  it('纯 config 变化 → changed 含 configChanged 且 from/to 版本相同', () => {
    const old = { plugins: [P()] }
    const next = { plugins: [P({ config: { theme: 'dark' } })] }
    const d = diffPacks(old, next)
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0].configChanged).toBe(true)
    expect(d.changed[0].from.version).toBe(d.changed[0].to.version)
  })

  it('config 键序不同但内容相同 → 不算变更（规范化比较）', () => {
    const old = { plugins: [P({ config: { a: 1, b: { x: 1, y: 2 } } })] }
    const next = { plugins: [P({ config: { b: { y: 2, x: 1 }, a: 1 } })] }
    const d = diffPacks(old, next)
    expect(d.changed).toHaveLength(0)
    expect(d.kept).toHaveLength(1)
  })

  it('config 变化 + 版本变化 → 同时携带 configChanged 与新旧版本', () => {
    const old = { plugins: [P()] }
    const next = { plugins: [P({ version: '1.1.0', config: { a: 1 } })] }
    const d = diffPacks(old, next)
    expect(d.changed[0].configChanged).toBe(true)
    expect(d.changed[0].from.version).toBe('1.0.0')
    expect(d.changed[0].to.version).toBe('1.1.0')
  })
})

describe('personaReaction（nochange 语义）', () => {
  it('四个人设都有 nochange 文案；未知 kind 返回空串', () => {
    for (const id of Object.keys(PERSONAS)) {
      const text = personaReaction(PERSONAS[id], 'nochange', VALID_PACK)
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    }
    expect(personaReaction(PERSONAS.maid, 'unknown-kind', VALID_PACK)).toBe('')
  })
})
