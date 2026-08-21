/**
 * lib/core/ai-session.js — AI 装配间会话持久化（v5 阶段 5 增强）
 *
 * 会话存于隔离根 hotplugRoot()/ai-sessions/<id>.json（与 packs/、state.json 同级，
 * 进程隔离铁律同样适用：测试/QA 一律用临时 DSH_HOME，绝不触碰真实 ~/.dsh）。
 *
 * 安全红线：
 *   - 会话只存 {id, persona, messages, pack, turn, createdAt, updatedAt}；
 *   - API key 绝不入会话文件（key 只在调用链内存中，见 ai.js）；
 *   - 消息内容为 LLM 原文（产物 JSON/闲聊文本），不含凭据。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hotplugRoot } from './paths.js'

/** 会话消息保留上限（超出裁掉最旧的；防 token 爆炸）。 */
export const SESSION_MAX_MESSAGES = 16
/** 单条消息内容截断上限（防超大上下文）。 */
export const SESSION_MAX_MESSAGE_CHARS = 3000

/** 会话目录（<dshRoot>/hotplug-hub/ai-sessions）。 */
export function sessionsDir() {
  return join(hotplugRoot(), 'ai-sessions')
}

/** 生成会话 id（时间基 + 随机后缀，无敏感信息）。 */
export function newSessionId() {
  return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 会话文件路径（id 白名单清洗，防路径穿越）。 */
export function sessionPath(id) {
  return join(sessionsDir(), String(id).replace(/[^a-zA-Z0-9._-]/g, '') + '.json')
}

/**
 * 裁剪会话消息：保留最近 SESSION_MAX_MESSAGES 条，单条截断超长。
 * kind='pack' 表示产物轮原始响应（透传给 LLM 时跳过——旧产物 JSON 会干扰
 * 后续轮，权威的当前清单由最新指令消息的 packCtx 提供）。
 * @param {Array<{role: string, content: string, kind?: string}>} messages
 * @returns {Array<{role: string, content: string, kind?: string}>}
 */
export function trimMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages
    .slice(-SESSION_MAX_MESSAGES)
    .map((m) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content.slice(0, SESSION_MAX_MESSAGE_CHARS) : String(m.content ?? ''),
      ...(m && m.kind === 'pack' ? { kind: 'pack' } : {}),
    }))
}

/**
 * 读取会话；不存在或损坏返回 null。
 * @param {string} id
 * @returns {object|null} {id, persona, messages, pack, turn, createdAt, updatedAt}
 */
export function loadSession(id) {
  if (typeof id !== 'string' || id.trim() === '') return null
  const file = sessionPath(id)
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data.id !== 'string' || data.id !== id.trim()) return null
    return {
      id: data.id,
      persona: typeof data.persona === 'string' ? data.persona : undefined,
      messages: trimMessages(Array.isArray(data.messages) ? data.messages : []),
      pack: data.pack && typeof data.pack === 'object' ? data.pack : null,
      turn: typeof data.turn === 'number' ? data.turn : 0,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    }
  } catch {
    return null
  }
}

/**
 * 保存会话（原子写：临时文件 + rename 替换，避免半写）。
 * @param {object} session {id, persona, messages, pack, turn, createdAt, updatedAt}
 * @returns {boolean} 是否成功
 */
export function saveSession(session) {
  if (!session || typeof session.id !== 'string' || session.id.trim() === '') return false
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    const file = sessionPath(session.id)
    const tmp = file + '.tmp'
    const payload = JSON.stringify({
      id: session.id,
      persona: session.persona,
      messages: trimMessages(session.messages),
      pack: session.pack && typeof session.pack === 'object' ? session.pack : null,
      turn: typeof session.turn === 'number' ? session.turn : 0,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt || new Date().toISOString(),
    })
    writeFileSync(tmp, payload, 'utf8')
    rmSync(file, { force: true })
    writeFileSync(file, payload, 'utf8')
    rmSync(tmp, { force: true })
    return true
  } catch {
    return false
  }
}

/** 列出全部会话摘要（按更新时间倒序，最多 50 个）。 */
export function listSessions() {
  try {
    const dir = sessionsDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
      .map((name) => loadSession(name.slice(0, -5)))
      .filter(Boolean)
      .map((s) => ({ id: s.id, persona: s.persona, turn: s.turn, updatedAt: s.updatedAt, packName: s.pack && s.pack.name }))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, 50)
  } catch {
    return []
  }
}

/** 删除会话。 */
export function deleteSession(id) {
  if (typeof id !== 'string' || id.trim() === '') return false
  try {
    rmSync(sessionPath(id), { force: true })
    return true
  } catch {
    return false
  }
}
