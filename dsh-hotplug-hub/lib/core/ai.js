/**
 * lib/core/ai.js — AI 装配间（多平台接入 + 人设化对话式装配，v5 阶段 5 增强）
 *
 * 把用户自然语言需求 → LLM（默认 deepseek-chat，可换任意 OpenAI 兼容端点）→
 * 结构化 hotpack 1.0 清单 → 权威 shared-core parseHotpack 校验（LLM 输出不可信：
 * 插件 id/name/version/source/config 全部过白名单与格式校验，产物必然可被中枢导入）。
 *
 * 多平台接入（provider 解析优先级）：
 *   1) opts.provider / opts.baseURL / opts.model / opts.apiKey（显式参数优先）；
 *   2) 环境变量 DSH_AI_PROVIDER / DSH_AI_BASE_URL / DSH_AI_MODEL / DSH_AI_API_KEY；
 *   3) 内置注册表 AI_PROVIDERS（deepseek / opencode / openrouter / siliconflow /
 *      moonshot / zhipu / minimax），key 读各自 DSH_*_API_KEY 环境变量。
 *   任一台遵循 OpenAI Chat Completions 协议的服务均可接入（custom 零代码）。
 *
 * 人设化对话式装配（aiChat）：
 *   - 4 人设可切换（maid 小织女仆[默认] / butler 执事管家 / neko 咪咪猫娘 /
 *     assistant 标准助手），只改语气与情绪价值，绝不影响契约/校验/密钥安全；
 *   - 首轮=需求→装配；后续轮=对话式增量修改（「换掉 xx 插件」「加个功能」），
 *     LLM 输出完整新清单则本地 diff（新增/移除/调整），纯文本则当闲聊回复；
 *   - 会话本地持久化（hotplugRoot()/ai-sessions/，key 绝不落盘），可续接。
 *
 * 安全与隔离：
 *   - API key 只经显式参数或环境变量读取；不打印、不落盘、不进会话文件；
 *     输出前统一脱敏（key→***，含用户消息历史）；
 *   - fetch 全程系统默认证书校验（TLS 铁律）；baseURL 必须 https://；
 *   - 超时（默认 90s）+ 响应体上限（1MB）+ 失败重试一次；
 *   - 产物校验失败时返回结构化错误（含 LLM 原文片段供排查，不含 key）。
 *
 * 最小真实调用验证：scripts/qa5-ai-assemble.mjs（进程隔离，key 经 env 注入）。
 */
// R3：改走 hub 适配层（core/hotpack）——AI 产物与 importPack 同一权威路径，
// 补齐展示适配（tags 码点安全截断）与 hotplug 附加语义（memory:{keep:true}）。
import { parseHotpack } from './hotpack.js'
import { PERSONAS, DEFAULT_PERSONA, buildSystemPrompt, resolvePersona, diffPacks, personaReaction } from './ai-persona.js'
import { loadSession, saveSession, newSessionId, trimMessages, deleteSession, listSessions } from './ai-session.js'

/**
 * 内置 provider 注册表（OpenAI Chat Completions 兼容；baseURL 不含 /chat/completions）。
 * 主动适配主流厂商（实测端点）：DeepSeek / OpenCode（Zen 与 Go）/ OpenRouter /
 * 硅基流动 / Moonshot / 智谱 GLM / MiniMax。任意未列出的 OpenAI 兼容厂商可用
 * custom（DSH_AI_BASE_URL + DSH_AI_MODEL + DSH_AI_API_KEY）接入，无需改代码。
 */
export const AI_PROVIDERS = {
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    envKey: 'DSH_DEEPSEEK_API_KEY',
  },
  opencode: {
    // OpenCode Go（订阅 credits）：https://opencode.ai/zen/go/v1/chat/completions
    // 模型 ID 不带 provider 前缀（实测：'opencode-go/kimi-k3' 返回 401 not supported，
    // 'kimi-k3' 返回 200）。默认 deepseek-v4-flash（Go 目录 DeepSeek V4 Flash，实测
    // 可用；hy3-preview 上游当前 "Model is unavailable"、kimi-k3 亦可用作对照）。
    // temperature=1：实测 Go 目录模型仅接受 temperature=1（0.3 被上游拒绝
    // "only 1 is allowed"）——厂商差异在此登记，配合 callCompletions 的温度
    // 自适应重试兜底。
    baseURL: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4-flash',
    envKey: 'DSH_OPENCODE_API_KEY',
    temperature: 1,
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    envKey: 'DSH_OPENROUTER_API_KEY',
  },
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    envKey: 'DSH_SILICONFLOW_API_KEY',
  },
  moonshot: {
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2',
    envKey: 'DSH_MOONSHOT_API_KEY',
  },
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5',
    envKey: 'DSH_ZHIPU_API_KEY',
  },
  minimax: {
    baseURL: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M2.7',
    envKey: 'DSH_MINIMAX_API_KEY',
  },
}

export const AI_TIMEOUT_MS = 90000
export const AI_MAX_RESPONSE_BYTES = 1 << 20 // 1MB
export const AI_MAX_RETRIES = 1

// 兼容导出：旧版单串 system prompt（组装轮语义，等价 assistant 人设）
export const SYSTEM_PROMPT = buildSystemPrompt('assistant', 'assembly')

// 人设相关 re-export（client/gateway/测试统一从 ai.js 取）
export { PERSONAS, DEFAULT_PERSONA, buildSystemPrompt, resolvePersona, diffPacks, personaReaction }
export { deleteSession, listSessions, loadSession, saveSession, newSessionId, trimMessages }

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
    `由 DSH AI 装配间根据需求生成：${input}`,
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
 * 单次 Chat Completions 调用（OpenAI 兼容协议；fetch，TLS 默认校验）。
 * 厂商差异自适应：部分模型仅接受 temperature=1（如 OpenCode Go 目录实测 kimi-k3），
 * 4xx 错误含 "temperature" 时自动以 temperature=1 重试一次（兜底，不依赖注册表登记）。
 * @param {string} apiKey
 * @param {string|Array<{role: string, content: string}>} userPrompt 字符串=单轮（旧兼容）；数组=完整 messages
 * @param {object} [opts] { endpoint, model, timeoutMs, temperature }
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
export async function callCompletions(apiKey, userPrompt, opts = {}) {
  const endpoint = opts.endpoint
  const model = opts.model
  const timeoutMs = opts.timeoutMs === undefined ? AI_TIMEOUT_MS : opts.timeoutMs
  const baseTemperature = opts.temperature === undefined ? 0.3 : opts.temperature
  const messages = Array.isArray(userPrompt)
    ? userPrompt
    : [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }]
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
          messages,
          temperature: baseTemperature,
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
      // 厂商差异自适应：模型仅接受 temperature=1（如 OpenCode Go kimi-k3）时重试
      if (baseTemperature !== 1 && /temperature/i.test(body)) {
        const r = await callCompletions(apiKey, messages, { ...opts, temperature: 1 })
        if (r.ok) return r
        return { ok: false, error: `AI 服务 HTTP ${res.status}：${body || '无响应体'}；temperature=1 重试仍失败：${r.error}` }
      }
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

/** 兼容旧导出名（内部/测试引用 callDeepSeek 的迁移期别名）。 */
export const callDeepSeek = callCompletions

/**
 * 解析 provider 配置（显式参数 > DSH_AI_* 通用 env > 内置注册表）。
 * @param {object} opts { provider, baseURL, model, apiKey }
 * @returns {{ok: boolean, baseURL?: string, model?: string, apiKey?: string, error?: string}}
 */
export function resolveAiProvider(opts = {}) {
  const env = process.env || {}
  const provider = (typeof opts.provider === 'string' && opts.provider.trim() !== '')
    ? opts.provider.trim()
    : (env.DSH_AI_PROVIDER || '').trim() || 'deepseek'
  const def = AI_PROVIDERS[provider]

  const baseURL = (typeof opts.baseURL === 'string' && opts.baseURL.trim() !== '')
    ? opts.baseURL.trim().replace(/\/+$/, '')
    : (env.DSH_AI_BASE_URL || '').trim() || (def ? def.baseURL : '')
  const model = (typeof opts.model === 'string' && opts.model.trim() !== '')
    ? opts.model.trim()
    : (env.DSH_AI_MODEL || '').trim() || (def ? def.model : '')

  let apiKey = (typeof opts.apiKey === 'string' && opts.apiKey.trim() !== '')
    ? opts.apiKey.trim()
    : ''
  if (apiKey === '') apiKey = (env.DSH_AI_API_KEY || '').trim()
  if (apiKey === '' && def && def.envKey) apiKey = (env[def.envKey] || '').trim()

  if (apiKey === '') {
    return { ok: false, error: `未配置 API Key（${def ? def.envKey : 'DSH_AI_API_KEY'} 环境变量或显式传入）` }
  }
  if (baseURL === '') {
    return { ok: false, error: `未配置 Base URL（provider 未知且未显式传入 DSH_AI_BASE_URL）` }
  }
  // TLS 铁律：拒绝非 https（本地明文端点不可用于生产装配）
  if (!/^https:\/\//i.test(baseURL)) {
    return { ok: false, error: `Base URL 必须 https://（TLS 铁律）：${baseURL}` }
  }
  if (model === '') {
    return { ok: false, error: '未配置模型名（DSH_AI_MODEL 或显式传入）' }
  }
  return {
    ok: true,
    baseURL,
    model,
    apiKey,
    provider,
    // 厂商 temperature 差异（如 OpenCode Go 目录仅接受 1）；缺省 0.3
    temperature: def && typeof def.temperature === 'number' ? def.temperature : 0.3,
  }
}

/**
 * 输出前统一脱敏：把 apiKey 从任意字符串字段中替换为 ***（防用户消息/回复误带）。
 * @param {*} value
 * @param {string} apiKey
 * @returns {*}
 */
function redactKey(value, apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') return value
  if (typeof value === 'string') return value.split(apiKey).join('***')
  if (Array.isArray(value)) return value.map((v) => redactKey(v, apiKey))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactKey(v, apiKey)
    return out
  }
  return value
}

/** 会话对外视图（含最近消息历史供 UI 恢复；不含任何凭据）。 */
function publicSession(session, apiKey) {
  return redactKey({
    id: session.id,
    persona: session.persona || DEFAULT_PERSONA,
    turn: session.turn,
    pack: session.pack || null,
    updatedAt: session.updatedAt,
    history: session.messages.slice(-8),
  }, apiKey)
}

/** 落盘前消息脱敏：用户消息里误贴的 key 绝不允许进会话文件（key 红线）。 */
function safeMessages(messages, apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') return messages
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: redactKey(m && m.content, apiKey),
    ...(m && m.kind === 'pack' ? { kind: 'pack' } : {}),
  }))
}

/**
 * 组装轮：需求 → LLM → 权威校验 → {manifest, pack, readme}（失败重试）。
 * @returns {Promise<{ok: boolean, manifest?: object, pack?: object, readme?: string, raw?: string, error?: string}>}
 */
async function runAssemblyTurn(cfg, endpoint, messages, opts) {
  const userText = messages[messages.length - 1] && messages[messages.length - 1].content || ''
  let lastContent = null
  let lastErr = ''
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt += 1) {
    const r = await callCompletions(cfg.apiKey, messages, {
      timeoutMs: opts.timeoutMs,
      endpoint,
      model: cfg.model,
      temperature: cfg.temperature,
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
      lastErr = `AI 产物未通过校验：${check.code} ${check.error}（已重试）`
      continue
    }
    const pack = check.pack
    return {
      ok: true,
      manifest,
      pack,
      readme: buildReadme(pack, userText.slice(0, 200)),
      raw: lastContent,
    }
  }
  // 重试仍失败：附带 LLM 原文片段（不含 key）便于排查
  const snippet = lastContent ? `；AI 原文片段：${String(lastContent).slice(0, 200)}` : ''
  return { ok: false, error: (lastErr || 'AI 装配失败') + snippet }
}

/**
 * AI 装配间会话入口：首轮=需求→装配；后续轮=对话式增量修改/闲聊。
 * @param {string} input 用户消息（首轮为需求，后续为对话指令）
 * @param {object} [opts]
 * @param {string} [opts.provider] 内置注册表名（deepseek/opencode/...）
 * @param {string} [opts.baseURL] 自定义 OpenAI 兼容端点（不含 /chat/completions）
 * @param {string} [opts.model] 模型名
 * @param {string} [opts.apiKey] 显式 key（优先）；缺省读 env
 * @param {string} [opts.persona] 人设 id（maid/butler/neko/assistant；缺省 maid）
 * @param {string} [opts.sessionId] 续接既有会话（缺省新建）
 * @param {boolean} [opts.persist] 是否落盘会话（缺省 true；aiAssemble 兼容层传 false）
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.endpoint] 测试注入（完整 chat completions 地址）
 * @returns {Promise<{ok: boolean, session?: object, reply?: string, pack?: object,
 *   readme?: string, manifest?: object, diff?: object, firstTurn?: boolean, error?: string}>}
 */
export async function aiChat(input, opts = {}) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') {
    return { ok: false, error: '需求不能为空' }
  }
  if (text.length > 4000) {
    return { ok: false, error: '需求过长（最多 4000 字符）' }
  }
  // 多平台 provider 解析（显式参数 > DSH_AI_* env > 内置注册表）
  const cfg = resolveAiProvider(opts)
  if (!cfg.ok) return { ok: false, error: cfg.error }
  // 完整 chat completions 地址：opts.endpoint 测试注入优先，否则 baseURL + /chat/completions
  const endpoint = (typeof opts.endpoint === 'string' && opts.endpoint.trim() !== '')
    ? opts.endpoint.trim()
    : `${cfg.baseURL}/chat/completions`
  const persist = opts.persist !== false

  // ---- 会话：恢复或新建 ----
  let session = null
  const sid = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : ''
  if (sid !== '') session = loadSession(sid)
  if (!session) {
    session = {
      id: newSessionId(),
      persona: (typeof opts.persona === 'string' && opts.persona.trim() !== '') ? opts.persona.trim() : undefined,
      messages: [],
      pack: null,
      turn: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }
  const persona = resolvePersona(session.persona || opts.persona || DEFAULT_PERSONA)
  const isFirstTurn = session.turn === 0 || !session.pack

  // ---- 消息上下文（人设 + 历史 + 最新指令/需求；全部脱敏，LLM 也看不到 key） ----
  session.messages = trimMessages([...session.messages, { role: 'user', content: text }])
  const requestMessages = [{ role: 'system', content: buildSystemPrompt(persona.id, isFirstTurn ? 'assembly' : 'chat') }]
  for (const m of session.messages.slice(0, -1)) {
    // 跳过产物轮原始响应（kind='pack'）：旧产物 JSON 会干扰后续轮——多轮修改后
    // 历史里的 JSON 已过期，权威的当前清单由最新指令消息的 packCtx 提供
    if (m.kind === 'pack') continue
    requestMessages.push({ role: m.role, content: redactKey(m.content, cfg.apiKey) })
  }
  if (isFirstTurn) {
    requestMessages.push({ role: 'user', content: redactKey(`用户需求：${text}\n请输出对应的 hotpack 1.0 插件包清单 JSON。`, cfg.apiKey) })
  } else {
    const packCtx = session.pack
      ? `当前已装配的 hotpack 1.0 清单：\n${JSON.stringify(session.pack)}\n\n`
      : ''
    requestMessages.push({ role: 'user', content: redactKey(`${packCtx}用户新指令：${text}\n（如需修改清单，输出完整新 JSON；否则正常对话回复）`, cfg.apiKey) })
  }

  if (isFirstTurn) {
    // ---- 首轮：装配（失败重试） ----
    const r = await runAssemblyTurn(cfg, endpoint, requestMessages, opts)
    if (!r.ok) return { ok: false, error: redactKey(r.error, cfg.apiKey) }
    session.pack = r.pack
    session.turn = 1
    session.updatedAt = new Date().toISOString()
    // kind='pack'：产物轮原始响应（历史透传时跳过，防旧 JSON 干扰后续轮）
    session.messages = trimMessages([...session.messages, { role: 'assistant', content: r.raw, kind: 'pack' }])
    if (persist) saveSession({ ...session, messages: safeMessages(session.messages, cfg.apiKey) })
    const reply = personaReaction(persona, 'success', r.pack)
    return {
      ok: true,
      session: publicSession(session, cfg.apiKey),
      reply: redactKey(reply, cfg.apiKey),
      manifest: r.manifest,
      pack: r.pack,
      readme: r.readme,
      diff: diffPacks(null, r.pack),
      firstTurn: true,
    }
  }

  // ---- 后续轮：对话式增量修改 / 闲聊 ----
  const r = await callCompletions(cfg.apiKey, requestMessages, {
    timeoutMs: opts.timeoutMs,
    endpoint,
    model: cfg.model,
    temperature: cfg.temperature,
  })
  if (!r.ok) return { ok: false, error: redactKey(r.error, cfg.apiKey) }
  const content = r.content
  let pack = null
  let readme = null
  let manifest = null
  let diff = null
  let reply = null
  const parsed = extractJson(content)
  if (parsed) {
    const check = parseHotpack(parsed)
    if (check.ok) {
      pack = check.pack
      manifest = parsed
      readme = buildReadme(pack, (session.pack && session.pack.description) || text.slice(0, 200))
      diff = diffPacks(session.pack, pack)
      session.pack = pack
      reply = personaReaction(persona, 'success', pack)
    }
  }
  if (reply === null) reply = content.trim() // 纯对话回复（LLM 自带人设语气）
  session.turn += 1
  session.updatedAt = new Date().toISOString()
  // 产物轮原始响应打 kind='pack'（历史透传时跳过）；闲聊轮纯文本保留透传
  session.messages = trimMessages([...session.messages, { role: 'assistant', content, ...(pack ? { kind: 'pack' } : {}) }])
  if (persist) saveSession({ ...session, messages: safeMessages(session.messages, cfg.apiKey) })
  return {
    ok: true,
    session: publicSession(session, cfg.apiKey),
    reply: redactKey(reply, cfg.apiKey),
    pack,
    readme,
    manifest,
    diff,
    firstTurn: false,
  }
}

/**
 * AI 装配兼容入口（v5 阶段 5 旧契约）：需求 → LLM → 权威校验 → {manifest, pack, readme}。
 * 语义 = aiChat 首轮但不建/不落会话（无对话上下文），供既有调用方与测试使用。
 * @param {string} input 用户需求
 * @param {object} [opts] 同 aiChat（persona 缺省 maid）
 * @returns {Promise<{ok: boolean, manifest?: object, pack?: object, readme?: string, raw?: string, error?: string}>}
 */
export async function aiAssemble(input, opts = {}) {
  const r = await aiChat(input, { ...opts, persist: false })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, manifest: r.manifest, pack: r.pack, readme: r.readme, raw: r.raw }
}
