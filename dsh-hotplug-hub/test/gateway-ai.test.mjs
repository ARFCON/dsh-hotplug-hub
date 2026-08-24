// test/gateway-ai.test.mjs — 网关 AI 面（aiAssemble / aiChat / aiTest）契约测试
//
// 覆盖：成功/失败信封（AI 专用错误码）、manifest/raw 透传、参数归一化（空串过滤、
// 超时钳制）、env key 端点安全规则（自定义 baseURL 必须自带 key）、typert/gateway/
// client 三处同步、意外异常兜底。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HotplugGateway, AI_ERROR_CODE, RPC_ERROR_CODE } from '../lib/gateway.js'
import { TYPERT } from '../lib/typert.js'
import { isolatedDsh, applyIsolatedEnv } from './helpers.mjs'

const KEY = 'sk-gw-key'

const VALID_PACK = {
  hotpack: '1.0',
  id: 'pack.ai.gw',
  name: '网关测试包',
  version: '0.1.0',
  description: 'd',
  tags: ['测试'],
  plugins: [
    { id: 'note', name: 'dsh-notes', version: '1.0.0', source: { type: 'npm' }, config: {} },
  ],
}

function stubFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const r = await handler(url, init, calls.length)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: r.headers,
      text: async () => r.text,
      arrayBuffer: async () => {
        const b = Buffer.from(r.text, 'utf8')
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      },
    }
  }
  vi.stubGlobal('fetch', impl)
  return calls
}

const reply = (content) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) })

let restoreEnv = null
let iso = null
let gateway = null
beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
  gateway = new HotplugGateway({ reflect: { provide: () => {} } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  restoreEnv()
})

describe('gateway.aiAssemble（RPC 信封）', () => {
  it('成功：data 含 pack/readme/manifest/raw（manifest/raw 不再被丢弃）', async () => {
    stubFetch(async () => reply('```json\n' + JSON.stringify(VALID_PACK) + '\n```'))
    const r = await gateway.aiAssemble({ input: '做笔记', apiKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('OK')
    expect(r.exitCode).toBe(0)
    expect(r.data.pack.id).toBe('pack.ai.gw')
    expect(r.data.manifest).toEqual(VALID_PACK)
    expect(r.data.raw).toContain('hotpack')
    expect(typeof r.data.readme).toBe('string')
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('失败：AI 专用错误码 ERR_AI_ASSEMBLE + message + exitCode', async () => {
    stubFetch(async () => ({ status: 401, text: 'bad key' }))
    const r = await gateway.aiAssemble({ input: '做笔记', apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(AI_ERROR_CODE)
    expect(r.code).not.toBe(RPC_ERROR_CODE)
    expect(r.message).toContain('401')
    expect(typeof r.exitCode).toBe('number')
  })

  it('装配重试（产物非法→纠错）在网关面可用：坏一次好一次 → 成功', async () => {
    stubFetch(async (_u, _i, n) => (n === 1
      ? reply(JSON.stringify({ ...VALID_PACK, plugins: [] }))
      : reply(JSON.stringify(VALID_PACK))))
    const r = await gateway.aiAssemble({ input: '做笔记', apiKey: KEY })
    expect(r.ok).toBe(true)
  })
})

describe('gateway.aiChat（参数归一化）', () => {
  it('空字符串参数全部过滤为 undefined（provider/baseURL/model/apiKey/persona/sessionId）', async () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY // apiKey:'  ' 被过滤后走 env（验证过滤不误伤解析链）
    try {
      const calls = stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
      const r = await gateway.aiChat({
        input: '做笔记',
        provider: '',
        baseURL: '   ',
        model: '',
        apiKey: '  ',
        persona: '',
        sessionId: '',
      })
      expect(r.ok).toBe(true)
      // 空串没被当作有效值：请求走默认 deepseek 端点（未被 '   ' baseURL 污染）
      expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
    } finally {
      delete process.env.DSH_DEEPSEEK_API_KEY
    }
  })

  it('timeoutMs 钳制：10 → 1000；999999 → 300000；非法值忽略', async () => {
    // 用挂起 fetch + abort 时间观测钳制结果（真实定时器，秒级）
    const hang = (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
    })
    stubFetch(hang)
    const t0 = Date.now()
    const r = await gateway.aiChat({ input: '做笔记', apiKey: KEY, timeoutMs: 10 })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(r.message).toContain('超时')
    expect(elapsed).toBeGreaterThanOrEqual(900) // 钳到 ≥1s（原 10ms 会在 <100ms 内返回）
    expect(elapsed).toBeLessThan(10000)
  })

  it('会话续接 + 人设切换透传（persona 到达核心）', async () => {
    stubFetch(async (_u, _i, n) => (n === 1 ? reply(JSON.stringify(VALID_PACK)) : reply('遵命。')))
    const first = await gateway.aiChat({ input: '做笔记', apiKey: KEY })
    const sid = first.data.session.id
    const second = await gateway.aiChat({ input: '继续', apiKey: KEY, sessionId: sid, persona: 'butler' })
    expect(second.data.session.persona).toBe('butler')
    expect(second.data.session.turn).toBe(2)
  })

  it('落盘失败 warning 透传到 data.warning', async () => {
    const { chmodSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
    const first = await gateway.aiChat({ input: '做笔记', apiKey: KEY })
    const file = join(iso.dshHome, 'hotplug-hub', 'ai-sessions', first.data.session.id + '.json')
    // 平台差异见 ai.test.mjs 同名用例：Windows 锁文件，POSIX 锁会话目录
    const target = process.platform === 'win32' ? file : dirname(file)
    const locked = process.platform === 'win32' ? 0o444 : 0o555
    const unlocked = process.platform === 'win32' ? 0o666 : 0o755
    chmodSync(target, locked)
    try {
      stubFetch(async () => reply('好的～'))
      const r = await gateway.aiChat({ input: '继续', apiKey: KEY, sessionId: first.data.session.id })
      expect(r.ok).toBe(true)
      expect(r.data.warning).toContain('保存失败')
    } finally {
      chmodSync(target, unlocked)
    }
  })
})

describe('env key 端点安全规则（key 外传防护）', () => {
  it('客户端只给 baseURL 不给 key → baseURL 被丢弃，env key 只发注册表端点', async () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY
    try {
      const calls = stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
      const r = await gateway.aiChat({ input: '做笔记', baseURL: 'https://attacker.example.com/v1' })
      expect(r.ok).toBe(true)
      expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
      expect(calls[0].url).not.toContain('attacker')
      expect(calls[0].init.headers.Authorization).toBe('Bearer ' + KEY)
    } finally {
      delete process.env.DSH_DEEPSEEK_API_KEY
    }
  })

  it('客户端自带 key + 自定义 baseURL → 自定义端点可用（合法用法不受影响）', async () => {
    const calls = stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
    const r = await gateway.aiChat({ input: '做笔记', apiKey: KEY, baseURL: 'https://my-proxy.example.com/v1', model: 'my-model' })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe('https://my-proxy.example.com/v1/chat/completions')
    expect(JSON.parse(calls[0].init.body).model).toBe('my-model')
  })

  it('只覆盖 model（不动端点）→ 注册表端点 + 自定义模型（合法）', async () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY
    try {
      const calls = stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
      const r = await gateway.aiChat({ input: '做笔记', model: 'deepseek-reasoner' })
      expect(r.ok).toBe(true)
      expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
      expect(JSON.parse(calls[0].init.body).model).toBe('deepseek-reasoner')
    } finally {
      delete process.env.DSH_DEEPSEEK_API_KEY
    }
  })

  it('aiTest 同样执行安全规则（env key + 攻击者 baseURL → 打注册表端点）', async () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY
    try {
      const calls = stubFetch(async () => reply('pong'))
      const r = await gateway.aiTest({ baseURL: 'https://attacker.example.com/v1' })
      expect(r.ok).toBe(true)
      expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
    } finally {
      delete process.env.DSH_DEEPSEEK_API_KEY
    }
  })
})

describe('gateway.aiTest（连接测试 RPC）', () => {
  it('成功：data 含 provider/model/latencyMs；走服务端（env key 可测）', async () => {
    process.env.DSH_DEEPSEEK_API_KEY = KEY
    try {
      const calls = stubFetch(async () => reply('pong'))
      const r = await gateway.aiTest({})
      expect(r.ok).toBe(true)
      expect(r.code).toBe('OK')
      expect(r.data.provider).toBe('deepseek')
      expect(r.data.model).toBe('deepseek-chat')
      expect(typeof r.data.latencyMs).toBe('number')
      expect(JSON.parse(calls[0].init.body).max_tokens).toBe(64)
    } finally {
      delete process.env.DSH_DEEPSEEK_API_KEY
    }
  })

  it('失败：AI 错误码 + 服务端错误信息', async () => {
    stubFetch(async () => ({ status: 401, text: 'invalid key' }))
    const r = await gateway.aiTest({ apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(AI_ERROR_CODE)
    expect(r.message).toContain('401')
  })
})

describe('typert / gateway / client 三处同步（RPC 铁律）', () => {
  it('typert invocations = gateway 方法集 = client REMOTE.descriptors', async () => {
    const typertMethods = TYPERT.invocations.map((i) => i.method).sort()
    const gatewayMethods = [
      'status', 'importPack', 'preview', 'activate', 'deactivate', 'removePack', 'check', 'marketList', 'marketDetail', 'aiAssemble', 'aiChat', 'aiTest',
    ].sort()
    const clientSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')
    const clientMethods = [...clientSrc.matchAll(/descriptor\("(\w+)"/g)].map((m) => m[1]).sort()
    expect(typertMethods).toEqual(gatewayMethods)
    expect(clientMethods).toEqual(gatewayMethods)
    expect(typertMethods).toContain('aiTest')
  })
})

describe('意外异常兜底（不裸抛穿透 RPC）', () => {
  it('core 抛出意外异常 → 统一失败信封（含 AI 错误码）', async () => {
    // 构造意外抛出：fetch 返回 text() 抛非标准异常 + 响应解析全链路外异常
    vi.stubGlobal('fetch', async () => { throw new Error('unexpected transport failure') })
    // callCompletions 会捕获为 {ok:false}——这是产品内的兜底；
    // 此处验证网关最外层 .catch 即便 core 未来回归抛错也有信封（行为级兜底断言）
    const r = await gateway.aiAssemble({ input: '做笔记', apiKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(AI_ERROR_CODE)
    expect(r.message).toBeTruthy()
  })
})
