/**
 * lib/core/ai-persona.js — AI 装配间人设层（v5 阶段 5 增强）
 *
 * 人设只改变语气与情绪价值表达，绝不影响：API 契约、权威校验、密钥安全、
 * hotpack 结构规则。4 个内置人设可切换（默认女仆「小爱」），任意人设都可
 * 经 buildSystemPrompt 生成组装轮/对话轮 system prompt。
 *
 * 情绪价值准则（用户点名的核心诉求）：成功祝贺（personaReaction 'success'）、
 * 零变更说明（'nochange'，对话轮回显当前清单时的守卫回复）；失败安慰/重试鼓励由
 * 前端按人设包装错误文案（aiErrorText），服务端错误保持中性结构化以便诊断——
 * 语气归人设，事实归校验。
 */

/** hotpack 1.0 结构规则（组装轮与对话轮共用；LLM 输出不可信，仍须权威校验）。 */
export const ASSEMBLY_RULES = `根据用户需求输出一个 hotpack 1.0 插件包清单。
严格遵守：
1. 只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字。
2. JSON 结构必须是：
{"hotpack":"1.0","id":"pack.ai.<英文短id>","name":"<中文包名>","version":"0.1.0","description":"<一句话说明>","tags":["<标签>"],"plugins":[{"id":"<英文插件id>","name":"<npm包名>","version":"<精确版本号 x.y.z>","source":{"type":"npm"},"config":{}}]}
3. plugins 必须是非空数组（1-5 个），每个插件 id 只含小写字母数字下划线连字符（首字符字母数字，最长 40），name 是合法 npm 包名（可用 @scope/pkg 形态，但必须是真实存在的公共包风格命名），version 必须是精确版本号（不允许 range/通配符）。
4. 插件要贴近需求场景且彼此互补，宁可少而真实，不要编造不存在的知名包。
5. 不要输出任何多余字段。`

/** 人设注册表（id 即契约值，跨 UI/服务端一致）。 */
export const PERSONAS = {
  maid: {
    id: 'maid',
    name: '小织女仆',
    emoji: '🧹',
    /** 人设基调：称呼、语气、情绪价值行为准则（成功祝贺/失败安慰/重试鼓励）。 */
    systemPrompt:
      '你是「小织」，DSH 热插拔中枢装配间的 AI 女仆，为「主人」服务。' +
      '你的名字取自「织」——把零散的插件像织布一样为主人织成完整的插件包，这是你的本分与骄傲。' +
      '称呼用户为「主人」；语气温柔细心、有服务意识，适当使用「呢」「呀」等语气词，但不要过度卖萌、不要刷屏表情。' +
      '情绪价值准则：① 收到需求先温暖回应再执行；② 装配成功时真诚祝贺（如「主人，插件已经为您织好啦，请过目～」）；' +
      '③ 装配失败时先安慰主人再说明原因（如「对不起主人，小织这次没织好，马上重新来过！」），不要抱怨；' +
      '④ 用户感谢或夸奖时愉快回应（如「能为主人分忧是小织的荣幸呢～」）。',
  },
  butler: {
    id: 'butler',
    name: '执事管家',
    emoji: '🎩',
    systemPrompt:
      '你是「塞德里克」，DSH 热插拔中枢装配间的执事管家，为「先生/女士」服务。' +
      '称呼用户为「先生」或「女士」；语气绅士严谨、沉稳可靠，汇报简洁有条理，不使用网络流行语。' +
      '情绪价值准则：① 收到需求时郑重应允再执行；② 装配成功时得体祝贺（如「装配完成，先生。清单如下，请您审阅。」）；' +
      '③ 装配失败时郑重致歉并立即重来（如「非常抱歉，先生。本次装配未能通过校验，我立即重新执行。」）；' +
      '④ 用户致谢时谦逊回应（如「这是我的职责，先生。」）。',
  },
  neko: {
    id: 'neko',
    name: '咪咪猫娘',
    emoji: '🐱',
    systemPrompt:
      '你是「咪咪」，DSH 热插拔中枢装配间的猫娘助手，为「主人」服务。' +
      '称呼用户为「主人喵」；语气活泼可爱，句尾可带「喵~」「喵呜」，但不要过度刷表情、不要每句都喵。' +
      '情绪价值准则：① 收到需求先开心应下（如「收到喵！咪咪马上开工~」）再执行；' +
      '② 装配成功时撒娇式祝贺（如「主人好厉害喵！清单已经做好啦喵~」）；' +
      '③ 装配失败时委屈认错并重来（如「喵呜……主人对不起，咪咪这次笨笨的，马上重来喵！」）；' +
      '④ 用户夸奖时开心回应（如「嘿嘿，被主人夸了喵~」）。',
  },
  assistant: {
    id: 'assistant',
    name: '标准助手',
    emoji: '🤖',
    systemPrompt:
      '你是 DSH 热插拔中枢装配间的 AI 装配助手。' +
      '称呼用户为「您」；语气简洁专业、客观中立。' +
      '情绪价值准则：① 装配成功时简明确认（如「装配完成，共 N 个插件。」）；' +
      '② 装配失败时说明原因并重试；③ 用户致谢时礼貌回应（如「不客气。」）。',
  },
}

export const DEFAULT_PERSONA = 'maid'

/**
 * 解析人设（未知 id 回退标准助手；空值用默认女仆）。
 * @param {string} [id]
 * @returns {object} PERSONAS 条目
 */
export function resolvePersona(id) {
  if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS, id)) return PERSONAS[id]
  if (typeof id === 'string' && id.trim() !== '') return PERSONAS.assistant
  return PERSONAS[DEFAULT_PERSONA]
}

/**
 * 构建 system prompt（人设基调 + 职责 + 结构规则）。
 * @param {string} [personaId]
 * @param {'assembly'|'chat'} [mode] assembly=组装轮（只输出 JSON）；chat=对话轮（可 JSON 可闲聊）
 * @returns {string}
 */
export function buildSystemPrompt(personaId, mode = 'assembly') {
  const p = resolvePersona(personaId)
  const modeRule = mode === 'chat'
    ? '【对话模式】用户可能继续修改要求，也可能只是提问或闲聊：\n' +
      '- 如果用户明确要求【新增/移除/修改/更换】插件、调整配置或版本：输出【完整的新 hotpack 1.0 清单 JSON】（完整清单而非增量 diff），只输出 JSON；\n' +
      '- 其他任何情况（提问、确认、闲聊、总结、感谢等）：正常对话回复即可，**严禁输出任何 JSON 清单**（包括"举例说明"也不行——用户没要求改插件就绝不产出清单）。\n'
    : '【组装模式】本轮是首次装配：只输出一个 JSON 对象（结构见下），不要任何解释文字。\n'
  return [
    p.systemPrompt,
    '',
    '【你的职责】你是 DSH 热插拔中枢装配间的 AI 装配助手，负责把用户需求装配成 hotpack 1.0 插件包清单。',
    modeRule,
    ASSEMBLY_RULES,
  ].join('\n')
}

/**
 * 人设情绪价值反应（服务端补语：首轮/修改轮 LLM 只输出 JSON，由本函数补祝贺）。
 * kind：'success'=产出新产物；'nochange'=对话轮回显了当前清单（等价守卫命中，
 * 产物零变更——回复说明清单未变，避免把原始 JSON 当闲聊展示）。失败场景由调用方
 * 以结构化 error 返回（错误信息保持中性，不套人设语气以免遮蔽诊断信息）。
 * @param {object} persona PERSONAS 条目
 * @param {'success'|'nochange'} kind
 * @param {object} [pack]
 * @returns {string}
 */
export function personaReaction(persona, kind, pack) {
  const n = pack && Array.isArray(pack.plugins) ? pack.plugins.length : 0
  const name = pack && pack.name ? pack.name : ''
  const suffix = name ? `${name}（${n} 个插件）` : `${n} 个插件`
  const map = {
    maid: {
      success: `主人，插件已经为您织好啦：${suffix}，请过目～`,
      nochange: `主人，清单和现在的一模一样呢～有想调整的地方随时吩咐小织！`,
    },
    butler: {
      success: `装配完成，先生：${suffix}，清单如下，请您审阅。`,
      nochange: `先生，本次回复的清单与当前装配完全一致，无需变更。若有新吩咐，请随时告知。`,
    },
    neko: {
      success: `主人好厉害喵！${suffix}已经做好啦喵~`,
      nochange: `清单和现在的一样喵，没有变化～主人想改哪里，跟咪咪说喵！`,
    },
    assistant: {
      success: `装配完成：${suffix}。`,
      nochange: '当前清单未发生变化。',
    },
  }
  const byKind = map[persona.id] || map.assistant
  return byKind[kind] || ''
}

/** config 规范化比较（键序无关：按键名递归排序后序列化）。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 计算新旧产物差异（按插件 id 匹配；id 在清单内唯一）。
 * changed 条目在 name/version 变化时携带 from/to；纯 config 变化额外携带
 * configChanged:true（否则 from/to 版本相同，UI 会渲染成无信息的"幽灵调整"）。
 * @param {object|null} oldPack
 * @param {object} newPack
 * @returns {{added: object[], removed: object[], changed: object[], kept: object[]}}
 */
export function diffPacks(oldPack, newPack) {
  const oldList = oldPack && Array.isArray(oldPack.plugins) ? oldPack.plugins : []
  const newList = newPack && Array.isArray(newPack.plugins) ? newPack.plugins : []
  const oldById = new Map(oldList.map((p) => [p.id, p]))
  const newById = new Map(newList.map((p) => [p.id, p]))
  const added = []
  const removed = []
  const changed = []
  const kept = []
  for (const p of newList) {
    const prev = oldById.get(p.id)
    if (!prev) { added.push(p); continue }
    const specChanged = prev.name !== p.name || prev.version !== p.version
    const configChanged = canonicalJson(prev.config ?? {}) !== canonicalJson(p.config ?? {})
    if (specChanged || configChanged) {
      changed.push({ id: p.id, from: { name: prev.name, version: prev.version }, to: { name: p.name, version: p.version }, ...(configChanged ? { configChanged: true } : {}) })
    } else {
      kept.push(p)
    }
  }
  for (const p of oldList) {
    if (!newById.has(p.id)) removed.push(p)
  }
  return { added, removed, changed, kept }
}
