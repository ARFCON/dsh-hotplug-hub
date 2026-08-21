// test/ai.test.mjs — AI 组装器（lib/core/ai.js）全分支单测（mock fetch，零网络）
// 覆盖：JSON 提取（纯文本/代码围栏/说明文字/坏 JSON）、成功路径（权威校验通过 +
// README 生成）、产物不合规重试、非 JSON 重试、网络/TLS 错误、HTTP 错误（key 脱敏）、
// 无 key、空需求/超长、重试后成功、解析异常。key 零落盘零打印断言。
import { describe, it, expect, afterEach } from 'vitest'
import { aiAssemble, extractJson, buildReadme, AI_MAX_RETRIES } from '../lib/core/ai.js'

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

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DSH_DEEPSEEK_API_KEY
})

const KEY = 'sk-test-secret'

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
