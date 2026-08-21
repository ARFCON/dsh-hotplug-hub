/**
 * lib/core/ai.js — AI 组装器（多平台接入，OpenAI 兼容协议统一，v5 阶段 5）
 *
 * 把用户自然语言需求 → LLM（默认 deepseek-chat，可换任意 OpenAI 兼容端点，
 * 如 OpenCode Go `opencode-go/hy3-preview`）→ 结构化 hotpack 1.0 清单 →
 * 权威 shared-core parseHotpack 校验（LLM 输出不可信：插件 id/name/version/
 * source/config 全部过白名单与格式校验，产物必然可被中枢导入）。
 *
 * 多平台接入（provider 解析优先级）：
 *   1) opts.provider / opts.baseURL / opts.model / opts.apiKey（显式参数优先）；
 *   2) 环境变量 DSH_AI_PROVIDER / DSH_AI_BASE_URL / DSH_AI_MODEL /
 *      DSH_AI_API_KEY（通用 OpenAI 兼容覆盖）；
 *   3) 内置注册表 AI_PROVIDERS（deepseek / opencode），key 读各自环境变量
 *      DSH_DEEPSEEK_API_KEY / DSH_OPENCODE_API_KEY。
 *   任一台遵循 OpenAI Chat Completions 协议的服务均可接入。
 *
 * 安全与隔离：
 *   - API key 只经显式参数或环境变量读取；本模块不打印、不落盘 key（错误信息
 *     脱敏）；
 *   - fetch 全程系统默认证书校验（TLS 铁律）；baseURL 必须 https://（拒绝明文）；
 *   - 超时（默认 90s）+ 响应体上限（1MB）+ 失败重试一次；
 *   - 产物校验失败时返回结构化错误（含 LLM 原文片段供排查，不含 key）。
 *
 * 最小真实调用验证：scripts/qa5-ai-assemble.mjs（进程隔离，key 经 env 注入）。
 */
import { parseHotpack } from '../../vendor-shared/index.mjs'

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
    // 'kimi-k3' 返回 200）。hy3-preview 为 Hy3 Preview（上游 Console Go 侧可用性
    // 以订阅为准；kimi-k3 等同一订阅下模型可作对照验证）。
    // temperature=1：实测 kimi-k3 等 Go 目录模型仅接受 temperature=1（0.3 被
    // 上游拒绝 "only 1 is allowed"）——厂商差异在此登记，配合 callCompletions
    // 的温度自适应重试兜底。
    baseURL: 'https://opencode.ai/zen/go/v1',
    model: 'hy3-preview',
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
 * 单次 Chat Completions 调用（OpenAI 兼容协议；fetch，TLS 默认校验）。
 * 厂商差异自适应：部分模型仅接受 temperature=1（如 OpenCode Go 目录实测 kimi-k3），
 * 4xx 错误含 "temperature" 时自动以 temperature=1 重试一次（兜底，不依赖注册表登记）。
 * @param {string} apiKey
 * @param {string} userPrompt
 * @param {object} [opts] { endpoint, model, timeoutMs, temperature }
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
export async function callCompletions(apiKey, userPrompt, opts = {}) {
  const endpoint = opts.endpoint
  const model = opts.model
  const timeoutMs = opts.timeoutMs === undefined ? AI_TIMEOUT_MS : opts.timeoutMs
  const baseTemperature = opts.temperature === undefined ? 0.3 : opts.temperature
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
        const r = await callCompletions(apiKey, userPrompt, { ...opts, temperature: 1 })
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
  // TLS 铁律：拒绝非 https（本地明文端点不可用于生产组装）
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
 * AI 组装主入口：需求 → LLM → 权威校验 → { manifest, pack, readme }。
 * 多平台：见 AI_PROVIDERS 与 resolveAiProvider（任意 OpenAI 兼容端点可接入）。
 * @param {string} input 用户需求
 * @param {object} [opts]
 * @param {string} [opts.provider] 内置注册表名（deepseek/opencode）
 * @param {string} [opts.baseURL] 自定义 OpenAI 兼容端点（不含 /chat/completions）
 * @param {string} [opts.model] 模型名（如 opencode-go/hy3-preview）
 * @param {string} [opts.apiKey] 显式 key（优先）；缺省读 env
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.endpoint] 测试注入（完整 chat completions 地址）
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
  // 多平台 provider 解析（显式参数 > DSH_AI_* env > 内置注册表）
  const cfg = resolveAiProvider(opts)
  if (!cfg.ok) return { ok: false, error: cfg.error }
  // 完整 chat completions 地址：opts.endpoint 测试注入优先，否则 baseURL + /chat/completions
  const endpoint = (typeof opts.endpoint === 'string' && opts.endpoint.trim() !== '')
    ? opts.endpoint.trim()
    : `${cfg.baseURL}/chat/completions`

  const userPrompt = `用户需求：${text}\n请输出对应的 hotpack 1.0 插件包清单 JSON。`

  let lastContent = null
  let lastErr = ''
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt += 1) {
    const r = await callCompletions(cfg.apiKey, userPrompt, {
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
