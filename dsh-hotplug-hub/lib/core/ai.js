/**
 * lib/core/ai.js — AI 组装器（真实 DeepSeek 调用，v5 阶段 5 新增）
 *
 * 把用户自然语言需求 → LLM（deepseek-chat）→ 结构化 hotpack 1.0 清单 →
 * 权威 shared-core parseHotpack 校验（LLM 输出不可信：插件 id/name/version/
 * source/config 全部过白名单与格式校验，产物必然可被中枢导入）。
 *
 * 安全与隔离：
 *   - API key 只经显式参数或环境变量 DSH_DEEPSEEK_API_KEY 读取；本模块不打印、
 *     不落盘 key（错误信息脱敏）；
 *   - fetch 全程系统默认证书校验（TLS 铁律）；调用方若净化 env 不应删除本模块
 *     需要读取的 DSH_DEEPSEEK_API_KEY；
 *   - 超时（默认 90s）+ 响应体上限（1MB）+ 失败重试一次；
 *   - 产物校验失败时返回结构化错误（含 LLM 原文片段供排查，不含 key）。
 *
 * 最小真实调用验证：scripts/qa5-ai-assemble.mjs（进程隔离，key 经 env 注入）。
 */
import { parseHotpack } from '../../vendor-shared/index.mjs'

export const AI_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const AI_MODEL = 'deepseek-chat'
export const AI_TIMEOUT_MS = 90000
export const AI_MAX_RESPONSE_BYTES = 1 << 20 // 1MB
export const AI_MAX_RETRIES = 1

const SYSTEM_PROMPT = `你是 DSH 热插拔中枢的「AI 组装器」。根据用户需求输出一个 hotpack 1.0 插件包清单。
严格遵守：
1. 只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字。
2. JSON 结构必须是：
{"hotpack":"1.0","id":"pack.ai.<英文短id>","name":"<中文包名>","version":"0.1.0","description":"<一句话说明>","tags":["<标签>"],"plugins":[{"id":"<英文插件id>","name":"<npm包名>","version":"<精确版本号 x.y.z>","source":{"type":"npm"},"config":{}}]}
3. plugins 必须是非空数组（1-5 个），每个插件 id 只含小写字母数字下划线连字符（首字符字母数字，最长 40），name 是合法 npm 包名（可用 @scope/pkg 形态，但必须是真实存在的公共包风格命名），version 必须是精确版本号（不允许 range/通配符）。
4. 插件要贴近需求场景且彼此互补，宁可少而真实，不要编造不存在的知名包。
5. 不要输出任何多余字段。`

/**
 * 从 LLM 响应文本提取 JSON（容忍 ```json 代码围栏、首尾说明文字、{...} 子串）。
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  try {
    return JSON.parse(t)
  } catch {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(t.slice(start, end + 1)) } catch { /* 落空 */ }
    }
  }
  return null
}

/** 由已校验产物生成 README（安装/使用说明）。 */
export function buildReadme(pack, input) {
  return [
    `# ${pack.name}`,
    '',
    `由 DSH AI 组装器根据需求生成：${input}`,
    '',
    '## 插件',
    '',
    ...pack.plugins.map((p) => `- \`${p.name}@${p.version}\` · ${p.id}`),
    '',
    '## 安装',
    '',
    '1. 在热插拔中枢导入本包。',
    '2. 确认版本与冲突信息后激活。',
    '3. 重启 DSH 生效。',
  ].join('\n')
}

/**
 * 单次 DeepSeek 调用（fetch，TLS 默认校验）。
 * @param {string} apiKey
 * @param {string} userPrompt
 * @param {object} [opts] { timeoutMs, endpoint, model }
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
export async function callDeepSeek(apiKey, userPrompt, opts = {}) {
  const endpoint = opts.endpoint || AI_ENDPOINT
  const model = opts.model || AI_MODEL
  const timeoutMs = opts.timeoutMs === undefined ? AI_TIMEOUT_MS : opts.timeoutMs
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 2048,
          stream: false,
        }),
        signal: ctrl.signal,
      })
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      return { ok: false, error: `AI 服务网络/TLS 错误：${msg}` }
    }
    if (!res.ok) {
      let body = ''
      try { body = (await res.text()).slice(0, 300) } catch { /* 忽略 */ }
      // 脱敏：错误响应体理论上不回显 key，但防御性替换
      body = body.replace(apiKey, '***')
      return { ok: false, error: `AI 服务 HTTP ${res.status}：${body || '无响应体'}` }
    }
    const raw = await res.arrayBuffer()
    if (raw.byteLength > AI_MAX_RESPONSE_BYTES) {
      return { ok: false, error: `AI 响应过大（>${AI_MAX_RESPONSE_BYTES} 字节）` }
    }
    const json = JSON.parse(Buffer.from(raw).toString('utf8'))
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'AI 响应缺少 choices[0].message.content' }
    }
    return { ok: true, content }
  } catch (e) {
    return { ok: false, error: `AI 响应解析失败：${String(e && e.message ? e.message : e)}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * AI 组装主入口：需求 → LLM → 权威校验 → { manifest, pack, readme }。
 * @param {string} input 用户需求
 * @param {object} [opts]
 * @param {string} [opts.apiKey] 显式 key（优先）；缺省读 DSH_DEEPSEEK_API_KEY
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.endpoint] 测试注入
 * @param {string} [opts.model]
 * @returns {Promise<{ok: boolean, manifest?: object, pack?: object, readme?: string, error?: string}>}
 */
export async function aiAssemble(input, opts = {}) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') {
    return { ok: false, error: '需求不能为空' }
  }
  if (text.length > 4000) {
    return { ok: false, error: '需求过长（最多 4000 字符）' }
  }
  const apiKey = (typeof opts.apiKey === 'string' && opts.apiKey.trim() !== '')
    ? opts.apiKey.trim()
    : (process.env.DSH_DEEPSEEK_API_KEY || '').trim()
  if (apiKey === '') {
    return { ok: false, error: '未配置 DeepSeek API Key（DSH_DEEPSEEK_API_KEY 环境变量或显式传入）' }
  }

  const userPrompt = `用户需求：${text}\n请输出对应的 hotpack 1.0 插件包清单 JSON。`

  let lastContent = null
  let lastErr = ''
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt += 1) {
    const r = await callDeepSeek(apiKey, userPrompt, {
      timeoutMs: opts.timeoutMs,
      endpoint: opts.endpoint,
      model: opts.model,
    })
    if (!r.ok) {
      lastErr = r.error
      continue
    }
    lastContent = r.content
    const manifest = extractJson(r.content)
    if (!manifest) {
      lastErr = 'AI 输出不是合法 JSON（已重试）'
      continue
    }
    // 权威校验（LLM 输出不可信：全量白名单/格式校验）
    const check = parseHotpack(manifest)
    if (!check.ok) {
      lastErr = `AI 产物未通过校验：${check.code} ${check.message}（已重试）`
      continue
    }
    const pack = check.pack
    return {
      ok: true,
      manifest,
      pack,
      readme: buildReadme(pack, text),
      raw: lastContent,
    }
  }
  // 重试仍失败：附带 LLM 原文片段（不含 key）便于排查
  const snippet = lastContent ? `；AI 原文片段：${String(lastContent).slice(0, 200)}` : ''
  return { ok: false, error: (lastErr || 'AI 组装失败') + snippet }
}
