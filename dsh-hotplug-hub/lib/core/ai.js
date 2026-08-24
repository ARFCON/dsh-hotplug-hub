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
 *     显式传入 persona 即切换会话人设并持久化（中途切换生效）；
 *   - 首轮=需求→装配；后续轮=对话式增量修改（「换掉 xx 插件」「加个功能」），
 *     LLM 输出完整新清单则本地 diff（新增/移除/调整），纯文本则当闲聊回复；
 *     对话轮回显当前清单（等价）→ 零变更说明（防 LLM 违规 JSON 覆盖产物）；
 *     对话轮输出非法清单 → 纠错反馈重试，仍失败则本轮失败（不当闲聊展示）；
 *   - 会话本地持久化（hotplugRoot()/ai-sessions/，key 绝不落盘），可续接；
 *     同一会话并发调用按会话级互斥串行（防后写覆盖先写丢历史）。
 *
 * 安全与隔离：
 *   - API key 只经显式参数或环境变量读取；不打印、不落盘、不进会话文件；
 *     输出前统一脱敏（key→***，含用户消息历史与错误响应体，全量替换）；
 *   - fetch 全程系统默认证书校验（TLS 铁律）；baseURL/endpoint 必须 https://；
 *   - 超时（默认 90s；温度自适应重试共享同一次调用预算）+ 响应体上限（1MB，
 *     Content-Length 预检 + 下载后精确校验）+ 失败纠错重试；429 读 Retry-After；
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
// 输出上限（与桌面外壳 CallLlm 的 4096 对齐；5 插件 + 中文描述的清单实测远小于此，
// 2048 曾在长清单场景把 JSON 截断在中间 → extractJson 必败 → 重试同样截断）
export const AI_MAX_OUTPUT_TOKENS = 4096

// 兼容导出：旧版单串 system prompt（组装轮语义，等价 assistant 人设）
export const SYSTEM_PROMPT = buildSystemPrompt('assistant', 'assembly')

// 人设相关 re-export（client/gateway/测试统一从 ai.js 取）
export { PERSONAS, DEFAULT_PERSONA, buildSystemPrompt, resolvePersona, diffPacks, personaReaction }
export { deleteSession, listSessions, loadSession, saveSession, newSessionId, trimMessages }

/**
 * 从 LLM 响应文本提取 JSON（容忍 ```json 代码围栏、首尾说明文字、{...} 子串）。
 * 多围栏回复（先解释围栏后 JSON 围栏）从最后一个围栏往前试——产物围栏通常在末尾；
 * 全部落空再试整段与首尾大括号子串。返回第一个解析为对象的候选。
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const t = text.trim()
  const fences = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean)
  for (const candidate of [...fences].reverse()) {
    try {
      const v = JSON.parse(candidate)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch { /* 尝试下一个候选 */ }
  }
  try {
    const v = JSON.parse(t)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch { /* 落空 */ }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(t.slice(start, end + 1))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch { /* 落空 */ }
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
 * 预算语义：opts.deadline 为本次调用族（含温度自适应重试）的共享墙钟上限——
 * 重试不再获得新的完整超时，防止 外层装配重试 × 温度重试 叠加出 4×timeout 的最坏墙钟。
 * @param {string} apiKey
 * @param {string|Array<{role: string, content: string}>} userPrompt 字符串=单轮（旧兼容）；数组=完整 messages
 * @param {object} [opts] { endpoint, model, timeoutMs, temperature, maxTokens, deadline, minContent }
 * @returns {Promise<{ok: boolean, content?: string, error?: string, status?: number, retryAfterMs?: number}>}
 */
export async function callCompletions(apiKey, userPrompt, opts = {}) {
  const endpoint = opts.endpoint
  const model = opts.model
  const maxTokens = Number.isFinite(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : AI_MAX_OUTPUT_TOKENS
  const baseTemperature = opts.temperature === undefined ? 0.3 : opts.temperature
  const messages = Array.isArray(userPrompt)
    ? userPrompt
    : [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }]
  // 共享 deadline（温度自适应重试沿用同一次调用的剩余预算）；单次上限不越过 deadline
  const attemptTimeout = () => {
    const perCall = opts.timeoutMs === undefined ? AI_TIMEOUT_MS : opts.timeoutMs
    if (opts.deadline === undefined) return perCall
    const remaining = opts.deadline - Date.now()
    if (remaining <= 0) return 0
    return Math.min(perCall, remaining)
  }
  const thisTimeout = attemptTimeout()
  if (thisTimeout <= 0) {
    return { ok: false, error: `AI 服务整体超时（预算 ${opts.deadlineLabel ?? '已'} 耗尽）` }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), thisTimeout)
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
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: ctrl.signal,
      })
    } catch (e) {
      if (e && (e.name === 'AbortError' || String(e.message).includes('abort'))) {
        const humanTimeout = thisTimeout < 1000 ? `${thisTimeout}ms` : `${Math.round(thisTimeout / 1000)}s`
        return { ok: false, error: `AI 服务超时（${humanTimeout}，可换更快的模型或稍后重试）` }
      }
      const msg = String(e && e.message ? e.message : e)
      return { ok: false, error: `AI 服务网络/TLS 错误：${msg}` }
    }
    if (!res.ok) {
      let body = ''
      try { body = clipByCodePoints(await res.text(), 300) } catch { /* 忽略 */ }
      // 脱敏：错误响应体理论上不回显 key，但防御性全量替换（split/join 与 redactKey 同源，
      // 避免 String.replace 只替换首次出现、key 二次回显时残留）
      body = redactKey(body, apiKey)
      // 限流：透出 Retry-After 供上层退避（毫秒；无头/非法时为 undefined）
      if (res.status === 429) {
        const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null
        const raMs = ra !== null && /^\d+(\.\d+)?$/.test(String(ra).trim()) ? Math.round(parseFloat(ra) * 1000) : undefined
        return { ok: false, status: 429, retryAfterMs: raMs, error: `AI 服务限流（HTTP 429）${raMs !== undefined ? `：服务端建议 ${Math.ceil(raMs / 1000)}s 后重试` : '：请稍后重试'}` }
      }
      // 厂商差异自适应：模型仅接受 temperature=1（如 OpenCode Go kimi-k3）时重试（共享 deadline）
      if (baseTemperature !== 1 && /temperature/i.test(body)) {
        const r = await callCompletions(apiKey, messages, { ...opts, temperature: 1 })
        if (r.ok) return r
        return { ok: false, error: `AI 服务 HTTP ${res.status}：${body || '无响应体'}；temperature=1 重试仍失败：${r.error}` }
      }
      return { ok: false, error: `AI 服务 HTTP ${res.status}：${body || '无响应体'}` }
    }
    // 体积防御第一步：Content-Length 预检（多数厂商携带）——超限直接拒绝，不再读体；
    // 第二步保留下载后精确校验（chunked 响应无 Content-Length 时兜底）。
    const lenHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null
    if (lenHeader !== null && /^\d+$/.test(String(lenHeader).trim()) && parseInt(lenHeader, 10) > AI_MAX_RESPONSE_BYTES) {
      return { ok: false, error: `AI 响应过大（Content-Length ${lenHeader} > ${AI_MAX_RESPONSE_BYTES} 字节）` }
    }
    const raw = await res.arrayBuffer()
    if (raw.byteLength > AI_MAX_RESPONSE_BYTES) {
      return { ok: false, error: `AI 响应过大（>${AI_MAX_RESPONSE_BYTES} 字节）` }
    }
    const json = JSON.parse(Buffer.from(raw).toString('utf8'))
    const message = json.choices && json.choices[0] && json.choices[0].message
    const content = message && message.content
    if (typeof content !== 'string' || content.trim() === '') {
      // 宽松模式（连接测试）：推理类模型（deepseek-reasoner / GLM-5.x / kimi 等）在
      // 小 max_tokens 下把预算全花在 reasoning_content、content 为空——HTTP 200 +
      // 合法 choices 结构已证明端点/鉴权/模型可用，这正是连接测试要回答的问题。
      if (opts.minContent === false && message && typeof message === 'object') {
        return { ok: true, content: '' }
      }
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
 * 会话级互斥（进程内）：同一 sessionId 的 aiChat 是 load→LLM(数十秒)→save 的
 * 读-改-写，并发两轮会以后写者整体覆盖先写者的 messages/pack（历史静默丢失）。
 * 按会话 id 串行、跨会话并行；锁在链空时清理防泄漏。跨进程一致性由"单桌面进程"
 * 的部署模型保证（网关为宿主进程内服务）。
 */
const sessionLocks = new Map()
function withSessionLock(sid, task) {
  const prev = sessionLocks.get(sid) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.then(() => {}, () => {})
  sessionLocks.set(sid, tail)
  tail.then(() => {
    if (sessionLocks.get(sid) === tail) sessionLocks.delete(sid)
  })
  return run
}

/** 稳定序列化（键排序）：用于"新产物与当前清单等价"判定，键序不影响结果。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 等价比较（键序 + 插件顺序均无关）：装配产物内插件无序，调序回显语义等价。 */
function packEquivalent(a, b) {
  if (!a || !b) return false
  const withSortedPlugins = (p) => stableStringify({ ...p, plugins: [...(p.plugins || [])].sort((x, y) => String(x.id).localeCompare(String(y.id))) })
  return withSortedPlugins(a) === withSortedPlugins(b)
}

/** 码点安全截断（与 ai-session sliceByCodePoints 同方针，供上下文/片段裁剪）。 */
function clipByCodePoints(str, maxChars) {
  return Array.from(String(str)).slice(0, maxChars).join('')
}

/** AI 产物附加规则（ASSEMBLY_RULES 明示 plugins 1-5；权威 parseHotpack 只保证非空）。
 * 错误信息用 ERR_AI_RULE 标记（AI 层规则），不冒用权威校验器的 ERR_ASSEMBLY_* 码。 */
function aiPackRuleError(pack) {
  if (pack && Array.isArray(pack.plugins) && pack.plugins.length > 5) {
    return `AI 产物未通过 AI 装配规则：ERR_AI_RULE plugins 最多 5 个（实际 ${pack.plugins.length}），请精选最贴需求的插件`
  }
  return null
}

/**
 * 组装轮：需求 → LLM → 权威校验 → {manifest, pack, readme, raw}（失败重试）。
 * 重试带纠错反馈：上一次的校验错误会作为 assistant 原文 + 用户纠错指令附加进
 * 重试请求——盲重发同一上下文对"结构违规"类错误命中率低。
 * 429 时按服务端 Retry-After 退避（≤5s 才等，更长则立即失败——不占用装配链路）。
 * 预算：每次 attempt 独立 deadline（timeoutMs）；温度自适应重试共享该次 attempt 预算。
 * @returns {Promise<{ok: boolean, manifest?: object, pack?: object, readme?: string, raw?: string, error?: string}>}
 */
async function runAssemblyTurn(cfg, endpoint, messages, opts, priorFailure = null) {
  const userText = messages[messages.length - 1] && messages[messages.length - 1].content || ''
  let lastContent = priorFailure ? priorFailure.content : null
  let lastErr = priorFailure ? priorFailure.error : ''
  let attemptMessages = messages
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt += 1) {
    if ((attempt > 0 || priorFailure) && lastContent !== null) {
      // 纠错反馈：带上一次失败原文与校验错误，要求模型修正（只影响本次请求，不落会话）。
      // priorFailure：调用方已有一次失败响应（对话轮产物非法）时直接从纠错起跑，不盲重发。
      attemptMessages = [
        ...messages,
        { role: 'assistant', content: clipByCodePoints(lastContent, 500) },
        { role: 'user', content: `上一次输出未通过 hotpack 1.0 校验：${lastErr}。请严格按结构规则重新输出，只输出修正后的 JSON，不要任何解释文字。` },
      ]
    } else {
      // 传输类失败（无产物原文）或首攻：按原上下文请求/平重试，不伪造"校验失败"反馈
      attemptMessages = messages
    }
    const r = await callCompletions(cfg.apiKey, attemptMessages, {
      timeoutMs: opts.timeoutMs,
      deadline: Date.now() + (opts.timeoutMs === undefined ? AI_TIMEOUT_MS : opts.timeoutMs),
      deadlineLabel: opts.timeoutMs === undefined ? `${AI_TIMEOUT_MS / 1000}s` : `${opts.timeoutMs / 1000}s`,
      endpoint,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: opts.maxTokens,
    })
    if (!r.ok) {
      lastErr = r.error
      // 限流退避：服务端建议 ≤5s 才值得等（仍有重试额度时）；否则立即失败
      if (r.status === 429 && attempt < AI_MAX_RETRIES && Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0 && r.retryAfterMs <= 5000) {
        await new Promise((resolve) => setTimeout(resolve, r.retryAfterMs))
      } else if (r.status === 429) {
        break
      }
      continue
    }
    lastContent = r.content
    const manifest = extractJson(r.content)
    if (!manifest) {
      lastErr = 'AI 输出不是合法 JSON'
      continue
    }
    // 权威校验（LLM 输出不可信：全量白名单/格式校验）+ AI 附加规则（plugins ≤5）
    const check = parseHotpack(manifest)
    if (!check.ok) {
      lastErr = `AI 产物未通过校验：${check.code} ${check.error}`
      continue
    }
    const ruleErr = aiPackRuleError(check.pack)
    if (ruleErr) {
      lastErr = ruleErr
      continue
    }
    const pack = check.pack
    return {
      ok: true,
      manifest,
      pack,
      readme: buildReadme(pack, clipByCodePoints(userText, 200)),
      raw: lastContent,
    }
  }
  // 重试仍失败：附带 LLM 原文片段（不含 key）便于排查
  const snippet = lastContent ? `；AI 原文片段：${clipByCodePoints(lastContent, 200)}` : ''
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
 * @param {string} [opts.persona] 人设 id（maid/butler/neko/assistant；缺省沿用会话/maid）。
 *   审计修复：显式传入即切换会话人设并持久化——此前会话 persona 一旦落盘就永远
 *   优先，UI 中途切换人设被静默忽略且不落盘，第三轮回弹。
 * @param {string} [opts.sessionId] 续接既有会话（缺省新建；id 无效/不存在时静默新建）
 * @param {boolean} [opts.persist] 是否落盘会话（缺省 true；aiAssemble 兼容层传 false）
 * @param {number} [opts.timeoutMs] 单次调用超时（装配轮为每次尝试的预算上限）
 * @param {number} [opts.maxTokens] 输出 token 上限（缺省 AI_MAX_OUTPUT_TOKENS）
 * @param {string} [opts.endpoint] 测试注入（完整 chat completions 地址）
 * @returns {Promise<{ok: boolean, session?: object, reply?: string, pack?: object,
 *   readme?: string, manifest?: object, raw?: string, diff?: object, firstTurn?: boolean,
 *   warning?: string, error?: string}>}
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
  // TLS 铁律同样覆盖测试注入端点（生产 baseURL 已在 resolveAiProvider 校验）
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, error: `端点必须 https://（TLS 铁律）：${endpoint}` }
  }
  const persist = opts.persist !== false

  // ---- 会话：恢复或新建（id 先定，锁才能按会话粒度串行） ----
  const sid = typeof opts.sessionId === 'string' && opts.sessionId.trim() !== '' ? opts.sessionId.trim() : ''
  const sidForLock = sid !== '' ? sid : `__new__${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return withSessionLock(sidForLock, async () => {
    let session = null
    if (sid !== '') session = loadSession(sid)
    if (!session) {
      session = {
        id: newSessionId(),
        messages: [],
        pack: null,
        turn: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }
    // 人设解析：显式参数 > 会话记录 > 默认。显式传入（含合法值）即更新并随会话落盘。
    const hasExplicitPersona = typeof opts.persona === 'string' && opts.persona.trim() !== ''
    const persona = resolvePersona(hasExplicitPersona ? opts.persona : (session.persona || DEFAULT_PERSONA))
    session.persona = persona.id
    const isFirstTurn = session.turn === 0 || !session.pack

    // ---- 消息上下文（人设 + 历史 + 最新指令/需求；全部脱敏，LLM 也看不到 key） ----
    // 当前轮全文进请求（≤4000 校验上限；trimMessages 的 3000 截断只作用于"历史"的落盘形态）
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
      requestMessages.push({ role: 'user', content: redactKey(`${packCtx}用户新指令：${text}\n（如需修改清单，输出完整新 JSON；否则正常对话回复，严禁复读当前清单 JSON）`, cfg.apiKey) })
    }

    /** 落盘 + 持久化失败告警（磁盘错误不吞：会话仍在内存与响应里，但刷新后不可续接）。 */
    const persistSession = () => {
      if (!persist) return undefined
      const saved = saveSession({ ...session, messages: safeMessages(session.messages, cfg.apiKey) })
      return saved ? undefined : '会话保存失败（磁盘错误）：本轮对话已生效，但刷新后可能无法续接'
    }

    if (isFirstTurn) {
      // ---- 首轮：装配（失败纠错重试） ----
      const r = await runAssemblyTurn(cfg, endpoint, requestMessages, opts)
      if (!r.ok) return { ok: false, error: redactKey(r.error, cfg.apiKey) }
      session.pack = r.pack
      session.turn = 1
      session.updatedAt = new Date().toISOString()
      // kind='pack'：产物轮原始响应（历史透传时跳过，防旧 JSON 干扰后续轮）
      session.messages = trimMessages([...session.messages, { role: 'assistant', content: r.raw, kind: 'pack' }])
      const warning = persistSession()
      const reply = personaReaction(persona, 'success', r.pack)
      return {
        ok: true,
        session: publicSession(session, cfg.apiKey),
        reply: redactKey(reply, cfg.apiKey),
        manifest: r.manifest,
        pack: r.pack,
        readme: r.readme,
        raw: redactKey(r.raw, cfg.apiKey),
        diff: diffPacks(null, r.pack),
        firstTurn: true,
        ...(warning ? { warning } : {}),
      }
    }

    // ---- 后续轮：对话式增量修改 / 闲聊 ----
    const r = await callCompletions(cfg.apiKey, requestMessages, {
      timeoutMs: opts.timeoutMs,
      deadline: Date.now() + (opts.timeoutMs === undefined ? AI_TIMEOUT_MS : opts.timeoutMs),
      deadlineLabel: opts.timeoutMs === undefined ? `${AI_TIMEOUT_MS / 1000}s` : `${opts.timeoutMs / 1000}s`,
      endpoint,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: opts.maxTokens,
    })
    if (!r.ok) return { ok: false, error: redactKey(r.error, cfg.apiKey) }
    const content = r.content
    let pack = null
    let readme = null
    let manifest = null
    let diff = null
    let reply = null
    let assistantKind = null // 'pack'=产物形态响应（历史跳过）；null=闲聊纯文本
    const parsed = extractJson(content)
    if (parsed) {
      const check = parseHotpack(parsed)
      const ruleErr = check.ok ? aiPackRuleError(check.pack) : null
      if (check.ok && !ruleErr) {
        if (session.pack && packEquivalent(session.pack, check.pack)) {
          // 等价守卫：对话轮 LLM 违规回显了当前清单（qa5b 真实链路复现；键序/插件
          // 调序均视为等价）——产物零变更，不覆盖 session.pack、不产出 diff；
          // 原始 JSON 形态标记 kind='pack' 防进下轮上下文
          assistantKind = 'pack'
          reply = personaReaction(persona, 'nochange', check.pack)
        } else {
          pack = check.pack
          manifest = parsed
          readme = buildReadme(pack, clipByCodePoints(text, 200))
          diff = diffPacks(session.pack, pack)
          session.pack = pack
          reply = personaReaction(persona, 'success', pack)
          assistantKind = 'pack'
        }
      } else {
        // 有修改意图（输出了 JSON）但产物非法（或违反 AI 附加规则）：与首轮同语义——
        // 从纠错反馈起跑重试，仍失败则本轮失败（不落盘、不当闲聊展示）
        const retry = await runAssemblyTurn(cfg, endpoint, requestMessages, opts, { content, error: ruleErr || `${check.code} ${check.error}` })
        if (!retry.ok) return { ok: false, error: redactKey(retry.error, cfg.apiKey) }
        if (session.pack && packEquivalent(session.pack, retry.pack)) {
          // 纠错后模型原样回显当前清单 → 同样按零变更处理（与直发路径守卫语义一致）
          reply = personaReaction(persona, 'nochange', retry.pack)
        } else {
          pack = retry.pack
          manifest = retry.manifest
          readme = retry.readme
          diff = diffPacks(session.pack, pack)
          session.pack = pack
          reply = personaReaction(persona, 'success', pack)
        }
        session.turn += 1
        session.updatedAt = new Date().toISOString()
        session.messages = trimMessages([...session.messages, { role: 'assistant', content: retry.raw, kind: 'pack' }])
        const warnInvalid = persistSession()
        return {
          ok: true,
          session: publicSession(session, cfg.apiKey),
          reply: redactKey(reply, cfg.apiKey),
          pack,
          readme,
          manifest,
          diff,
          firstTurn: false,
          ...(warnInvalid ? { warning: warnInvalid } : {}),
        }
      }
    }
    if (reply === null) reply = content.trim() // 纯对话回复（LLM 自带人设语气）
    session.turn += 1
    session.updatedAt = new Date().toISOString()
    // 产物轮原始响应打 kind='pack'（历史透传时跳过）；闲聊轮纯文本保留透传
    session.messages = trimMessages([...session.messages, { role: 'assistant', content, ...(assistantKind === 'pack' ? { kind: 'pack' } : {}) }])
    const warning = persistSession()
    return {
      ok: true,
      session: publicSession(session, cfg.apiKey),
      reply: redactKey(reply, cfg.apiKey),
      pack,
      readme,
      manifest,
      diff,
      firstTurn: false,
      ...(warning ? { warning } : {}),
    }
  })
}

/**
 * AI 连接测试（网关 aiTest 的核心实现）：最小 ping 请求验证 provider 端点/模型/key。
 * 与装配同一套 provider 解析、TLS 铁律、超时与脱敏——测试通过即可装配。
 * @param {object} [opts] 同 aiChat 的 provider/baseURL/model/apiKey/timeoutMs/endpoint
 * @returns {Promise<{ok: boolean, provider?: string, model?: string, latencyMs?: number, error?: string}>}
 */
export async function aiTestConnection(opts = {}) {
  const cfg = resolveAiProvider(opts)
  if (!cfg.ok) return { ok: false, error: cfg.error }
  const endpoint = (typeof opts.endpoint === 'string' && opts.endpoint.trim() !== '')
    ? opts.endpoint.trim()
    : `${cfg.baseURL}/chat/completions`
  if (!/^https:\/\//i.test(endpoint)) {
    return { ok: false, error: `端点必须 https://（TLS 铁律）：${endpoint}` }
  }
  const timeoutMs = opts.timeoutMs === undefined ? 15000 : opts.timeoutMs
  const startedAt = Date.now()
  const r = await callCompletions(cfg.apiKey, [{ role: 'user', content: 'ping' }], {
    endpoint,
    model: cfg.model,
    temperature: cfg.temperature,
    timeoutMs,
    deadline: Date.now() + timeoutMs,
    deadlineLabel: `${timeoutMs / 1000}s`,
    maxTokens: 64,
    minContent: false, // 连接测试只证明可用性；推理模型 content 为空不影响判定
  })
  if (!r.ok) return { ok: false, error: redactKey(r.error, cfg.apiKey) }
  return { ok: true, provider: cfg.provider, model: cfg.model, latencyMs: Date.now() - startedAt }
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
