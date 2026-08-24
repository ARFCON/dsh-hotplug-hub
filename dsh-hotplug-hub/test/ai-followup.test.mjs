// test/ai-followup.test.mjs — AI 装配间多轮会话深度行为（mock fetch，零网络）
//
// 覆盖 ai.test.mjs 之外的多轮面：3 轮以上会话演进、kind='pack' 轮的历史隔离、
// 人设中途切换的 system prompt 生效与持久化、失败轮不落盘、闲聊轮历史透传、
// 会话 16 条上限在多轮下的真实收敛、无效 sessionId 静默新建（契约化）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiChat } from '../lib/core/ai.js'
import { loadSession, sessionsDir, SESSION_MAX_MESSAGES } from '../lib/core/ai-session.js'
import { isolatedDsh, applyIsolatedEnv } from './helpers.mjs'

const KEY = 'sk-followup-key'

const VALID_PACK = {
  hotpack: '1.0',
  id: 'pack.ai.follow',
  name: '多轮测试包',
  version: '0.1.0',
  description: 'd',
  tags: ['测试'],
  plugins: [
    { id: 'note', name: 'dsh-notes', version: '1.0.0', source: { type: 'npm' }, config: {} },
  ],
}

const packWith = (extra) => ({
  ...VALID_PACK,
  plugins: [...VALID_PACK.plugins, extra],
})

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
beforeEach(() => {
  iso = isolatedDsh()
  restoreEnv = applyIsolatedEnv(iso.dshHome)
})
afterEach(() => {
  vi.unstubAllGlobals()
  restoreEnv()
})

describe('多轮会话演进（≥4 轮）', () => {
  it('轮次/历史/产物随轮演进；最终落盘与会话文件一致', async () => {
    const calls = stubFetch(async (_u, _i, n) => {
      if (n === 1) return reply(JSON.stringify(VALID_PACK))
      if (n === 2) return reply(JSON.stringify(packWith({ id: 'search', name: 'dsh-search', version: '1.1.0', source: { type: 'npm' }, config: {} })))
      return reply('好的主人，已按您的要求调整～')
    })
    const r1 = await aiChat('做笔记', { apiKey: KEY })
    const sid = r1.session.id
    const r2 = await aiChat('加全文搜索', { apiKey: KEY, sessionId: sid })
    const r3 = await aiChat('为什么这么选？', { apiKey: KEY, sessionId: sid })
    const r4 = await aiChat('谢谢', { apiKey: KEY, sessionId: sid })
    expect([r1, r2, r3, r4].every((r) => r.ok)).toBe(true)
    expect(r4.session.turn).toBe(4)
    expect(r2.pack.plugins).toHaveLength(2)
    expect(r3.pack).toBeNull()
    expect(r4.pack).toBeNull()
    const stored = loadSession(sid)
    expect(stored.turn).toBe(4)
    expect(stored.pack.plugins).toHaveLength(2)
    // 请求次数 = 4 轮（r3/r4 纯闲聊不触发纠错重试）
    expect(calls.length).toBe(4)
  })

  it('kind=pack 的产物轮不进后续请求历史（防旧 JSON 干扰），闲聊轮正常透传', async () => {
    const calls = stubFetch(async (_u, _i, n) => {
      if (n === 1) return reply(JSON.stringify(VALID_PACK))
      if (n === 2) return reply('收到，我先确认一下需求～')
      return reply('没问题～')
    })
    const r1 = await aiChat('做笔记', { apiKey: KEY })
    const sid = r1.session.id
    await aiChat('稍等，我想想', { apiKey: KEY, sessionId: sid })
    const r3 = await aiChat('好了，继续', { apiKey: KEY, sessionId: sid })
    expect(r3.ok).toBe(true)
    const body3 = JSON.parse(calls[2].init.body)
    // 历史段（system 之后、当前指令之前）不得出现旧产物 JSON；用户/闲聊消息正常透传
    const history = body3.messages.slice(1, -1)
    expect(history.some((m) => m.content.includes('"hotpack":"1.0"'))).toBe(false)
    const contents = body3.messages.map((m) => m.content)
    expect(contents.some((c) => c.includes('做笔记'))).toBe(true)
    expect(contents.some((c) => c.includes('稍等，我想想'))).toBe(true)
    expect(contents.some((c) => c.includes('收到，我先确认一下需求～'))).toBe(true)
    // 当前权威清单由 packCtx 提供（最新指令消息内）
    expect(body3.messages.at(-1).content).toContain('当前已装配的 hotpack 1.0 清单')
  })
})

describe('人设中途切换（新契约：显式切换生效并持久化）', () => {
  it('切换后 system prompt 立即用新人设；落盘 persona 更新；后续轮不带参数沿用新人设', async () => {
    const calls = stubFetch(async (_u, _i, n) => {
      if (n === 1) return reply(JSON.stringify(VALID_PACK))
      return reply('遵命。')
    })
    const r1 = await aiChat('做笔记', { apiKey: KEY, persona: 'maid' })
    expect(r1.session.persona).toBe('maid')
    expect(JSON.parse(calls[0].init.body).messages[0].content).toContain('小织')
    const r2 = await aiChat('换成执事风格', { apiKey: KEY, sessionId: r1.session.id, persona: 'butler' })
    expect(r2.session.persona).toBe('butler')
    const sys2 = JSON.parse(calls[1].init.body).messages[0].content
    expect(sys2).toContain('塞德里克')
    expect(sys2).not.toContain('小织')
    expect(loadSession(r1.session.id).persona).toBe('butler')
    const r3 = await aiChat('继续', { apiKey: KEY, sessionId: r1.session.id })
    expect(r3.session.persona).toBe('butler')
    expect(JSON.parse(calls[2].init.body).messages[0].content).toContain('塞德里克')
  })

  it('非法人设 id → 回退 assistant（不抛错），并以此为准落盘', async () => {
    stubFetch(async (_u, _i, n) => (n === 1 ? reply(JSON.stringify(VALID_PACK)) : reply('好的。')))
    const r1 = await aiChat('做笔记', { apiKey: KEY })
    const r2 = await aiChat('继续', { apiKey: KEY, sessionId: r1.session.id, persona: 'hacker-persona' })
    expect(r2.ok).toBe(true)
    expect(r2.session.persona).toBe('assistant')
    expect(loadSession(r1.session.id).persona).toBe('assistant')
  })
})

describe('失败轮不污染会话', () => {
  it('首轮失败后再成功：会话里只有一条该需求的用户消息（失败轮不落盘、成功重发不重复）', async () => {
    let mode = 'fail' // 首次调用（含其纠错重试）全部 500；之后切换为成功
    stubFetch(async () => (mode === 'fail'
      ? { status: 500, text: 'server boom' }
      : reply(JSON.stringify(VALID_PACK))))
    const fail = await aiChat('做笔记', { apiKey: KEY })
    expect(fail.ok).toBe(false)
    mode = 'ok'
    const ok = await aiChat('做笔记', { apiKey: KEY })
    expect(ok.ok).toBe(true)
    const stored = loadSession(ok.session.id)
    const userMsgs = stored.messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
  })

  it('对话轮产物非法且纠错仍失败 → 会话文件字节级不变（不半写）', async () => {
    stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
    const r1 = await aiChat('做笔记', { apiKey: KEY })
    const before = readFileSync(join(sessionsDir(), r1.session.id + '.json'), 'utf8')
    stubFetch(async () => reply(JSON.stringify({ ...VALID_PACK, plugins: [] })))
    const r2 = await aiChat('改成空清单', { apiKey: KEY, sessionId: r1.session.id })
    expect(r2.ok).toBe(false)
    const after = readFileSync(join(sessionsDir(), r1.session.id + '.json'), 'utf8')
    expect(after).toBe(before)
  })
})

describe('会话上下文上限（16 条）在多轮下的收敛', () => {
  it('超过 16 条后落盘只保留最近 16 条，请求仍正常', async () => {
    stubFetch(async (_u, _i, n) => (n === 1 ? reply(JSON.stringify(VALID_PACK)) : reply('嗯嗯')))
    const r1 = await aiChat('需求', { apiKey: KEY })
    const sid = r1.session.id
    for (let i = 0; i < 12; i += 1) {
      const r = await aiChat('闲聊 ' + i, { apiKey: KEY, sessionId: sid })
      expect(r.ok).toBe(true)
    }
    const stored = loadSession(sid)
    expect(stored.messages.length).toBeLessThanOrEqual(SESSION_MAX_MESSAGES)
    expect(stored.messages.length).toBe(SESSION_MAX_MESSAGES)
    // 最新的闲聊在，最早的（首轮 user）已被滑出
    const contents = stored.messages.map((m) => m.content)
    expect(contents).toContain('闲聊 11')
    expect(contents).not.toContain('需求')
  })
})

describe('sessionId 契约', () => {
  it('无效/不存在的 sessionId → 静默新建会话（续接失败不报错，契约化行为）', async () => {
    stubFetch(async () => reply(JSON.stringify(VALID_PACK)))
    const r = await aiChat('做笔记', { apiKey: KEY, sessionId: 'ai-does-not-exist' })
    expect(r.ok).toBe(true)
    expect(r.session.id).not.toBe('ai-does-not-exist')
    expect(r.firstTurn).toBe(true)
  })
})
