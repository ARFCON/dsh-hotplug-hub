/**
 * lib/gateway.js — Remote 网关（v5 阶段 3 自 index.js 拆出）
 *
 * R-v5-10（v5 阶段 3）：网关错误序列化统一为 {ok, code, message, exitCode}——
 * error 字符串字段废弃（兼容保留：message 优先，error 回退）；client.js 已适配。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { packsDir, statePath } from './core/paths.js'
import {
  loadPackManifest, readState, writeState, packDirExists,
} from './core/state.js'
import { statusSync, importPackSync, previewPack, checkAsync } from './core/status.js'
import { marketListAsync, marketDetailAsync } from './core/market.js'
import { aiAssemble, aiChat as aiChatCore, aiTestConnection } from './core/ai.js'
import { mountPack, unmountPack, removePatchBlock } from './core/patch.js'
import { exitCodeForCode } from '../vendor-shared/index.mjs'

/** 网关通用失败码（RPC 域，非 CLI ERROR_CODES 表）。 */
export const RPC_ERROR_CODE = 'ERR_HOTPLUG_FAILED'
/** AI 装配专用失败码：与通用包管理错误区分（UI 可按码给出 AI 专属提示）。 */
export const AI_ERROR_CODE = 'ERR_AI_ASSEMBLE'

/** AI 参数超时钳制范围：过小必超时、过大卡死会话，1s–300s 之间交由核心默认 90s。 */
const AI_TIMEOUT_MIN_MS = 1000
const AI_TIMEOUT_MAX_MS = 300000

/**
 * RPC 结果归一化：失败统一 {ok:false, code, message, exitCode}；
 * 兼容保留 error 字段（迁移期 client 可回退读取）。
 * 审计修复：exitCode 只由 code 推导（shared exitCodeForCode）——此前 result 未带
 * exitCode 时一律归一为 1，导致 hotpack 校验错误（ERR_ASSEMBLY_*，应为 exit 3）被
 * 压成 exit 1，32 码退出码契约从不透传。
 * @param {object} result
 * @returns {object}
 */
export function normalizeRpc(result) {
  if (!result) return result
  if (result.ok !== false) {
    // 审计修复：成功信封统一补 code:'OK' / exitCode:0——此前只有 aiAssemble/aiChat
    // 手写 {code:'OK', data, exitCode:0}，其余方法（status/importPack/activate…）裸返回，
    // RPC 信封 {ok, code, exitCode} 不统一；现在所有成功响应统一携带 OK/0。
    return {
      ...result,
      code: result.code === undefined ? 'OK' : result.code,
      exitCode: result.exitCode === undefined ? 0 : result.exitCode,
    }
  }
  const code = typeof result.code === 'string' && result.code !== '' ? result.code : RPC_ERROR_CODE
  return {
    ...result,
    code,
    message: typeof result.message === 'string' ? result.message : (typeof result.error === 'string' ? result.error : '操作失败'),
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : exitCodeForCode(code),
  }
}

class HotplugGateway extends TypertRemoteService {
  chain = Promise.resolve()

  constructor(ctx) {
    super(ctx, 'dshHotplug')
    // 与 lib/typert.js、lib/client.js REMOTE.descriptors 三处同步。
    const methods = ['status', 'importPack', 'preview', 'activate', 'deactivate', 'removePack', 'check', 'marketList', 'marketDetail', 'aiAssemble', 'aiChat', 'aiTest']
    for (const method of methods) {
      const decorator = Remote(method)
      decorator(HotplugGateway.prototype[method], {
        name: method,
        private: false,
        static: false,
        addInitializer: (initializer) => initializer.call(this),
      })
    }
  }

  /** 变更类操作串行化：同一时刻只动一次 profile。 */
  serialize(task) {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => {}, () => {})
    return run
  }

  status() {
    return normalizeRpc(statusSync())
  }

  importPack(text) {
    // 审计修复：importPack 写 packs/<id>/hotpack.json，须与 activate/deactivate/removePack
    // 串行化——此前未串行化，activate 挂载 v1 期间 importPack 可覆盖 manifest 为 v2
    // （activePack 尚未写入、非原子检查被绕过），造成「已激活状态 / 磁盘清单 / 实际产物」
    // 三者不一致。现与其它变更类操作同走 serialize 链。
    return this.serialize(async () => importPackSync(text)).then(normalizeRpc)
  }

  preview(packId) {
    return previewPack(packId).then(normalizeRpc)
  }

  /** state.json 损坏时统一拒绝变更（R3）：损坏状态下 activePack/activeInstall 不可
   *  信，任何写盘都会把孤儿产物（patch 块/link 依赖/npm 包）永久不可回收。 */
  stateCorrupted() {
    return readState().corrupted === true
      ? { ok: false, error: `state.json 损坏（无法安全变更），请先检查/备份后删除：${statePath()}` }
      : null
  }

  activate(packId) {
    return this.serialize(async () => {
      // R3：磁盘 manifest 复验——无效（篡改/手改坏）清单拒绝激活，plugin name/version/
      // repo 不再绕过权威校验进入 pnpm spec 与 profile package.json。
      const loaded = loadPackManifest(packId)
      if (loaded.status === 'missing') return { ok: false, error: `未找到包：${packId}（先导入 hotpack）` }
      if (loaded.status === 'invalid') {
        // 缺陷 A 修复：透传 loadPackManifest 的 CLI 域错误码（code），与 importPack/preview 口径一致。
        return { ok: false, code: loaded.code, error: `包 ${packId} 清单校验失败：${loaded.error}（请重新导入）` }
      }
      const manifest = loaded.pack
      const corrupted = this.stateCorrupted()
      if (corrupted) return corrupted
      const state = readState()
      // 大小写归一（win32 与 NTFS 语义一致）：重复激活同包（RPC 传大小写变体）判
      // already 而非无谓的卸载重挂——state 恒存权威 manifest.id，正常路径精确命中。
      const alreadyActive = process.platform === 'win32'
        ? String(state.activePack ?? '').toLowerCase() === String(packId).toLowerCase()
        : state.activePack === packId
      if (alreadyActive) {
        // 自愈（审计修复）：历史脏 state 里可能存着大小写变体（修复前 activate 落盘的
        // 原样 packId）——already 短路会把它永久留住（statusSync 严格比对持续失配且
        // 无法经再次 activate 纠正）。顺手回写权威 id，一次即愈。
        if (state.activePack !== manifest.id) {
          const healed = readState()
          healed.activePack = manifest.id
          if (healed.activeInstall && healed.activeInstall.packId === state.activePack) healed.activeInstall.packId = manifest.id
          writeState(healed)
        }
        return { ok: true, already: true, restartNeeded: false }
      }
      const events = []
      // R3（切换原子性）：记录「卸载了什么」，挂载失败时恢复上一包（或清空状态），
      // 保证任何返回路径上 state.activePack 与磁盘 hotplug 块一致。
      let previous = null
      let removedPreviousBlockOnly = false
      if (state.activePack) {
        const prevLoaded = loadPackManifest(state.activePack)
        if (prevLoaded.status === 'ok') {
          previous = prevLoaded.pack
          // 只撤销上一包「实际安装/替换」的 npm 包（reused 的预存依赖保留，无损替换）
          const unmounted = await unmountPack(previous, { installedNpm: state.activeInstall?.installedNpm })
          if (!unmounted.ok) return unmounted
          events.push(`已卸载上一个包：${previous.name ?? previous.id}（无损替换，记忆与 store 保留）`)
        } else {
          // 审计修复：manifest 缺失/无效（状态引用已删包或清单损坏）时仍须移除旧
          // patch 块，否则激活新包后残留旧 `## hotplug:<id>` 块，形成双块不一致。
          const removed = removePatchBlock(state.activePack)
          if (!removed.ok) return { ok: false, error: removed.error }
          removedPreviousBlockOnly = true
        }
      }
      const mounted = await mountPack(manifest)
      // mountPack 已事务化：失败时内部回滚 link/bundles/patch/npm；R3：切换场景下
      // 上一包已被卸载，还需保证「state.activePack ↔ 磁盘」一致——按序尝试恢复
      // 上一包；恢复失败（或上一包本就不可恢复）则清空激活状态与磁盘对齐。
      if (!mounted.ok) {
        if (previous !== null) {
          const remount = await mountPack(previous)
          if (remount.ok) {
            const next = readState()
            // 恢复后 activeInstall 反映重装产物（卸载时旧 installedNpm 已被撤）
            next.activeInstall = { packId: previous.id, installedNpm: Array.isArray(remount.installedNpm) ? remount.installedNpm : [] }
            writeState(next)
            events.push(`新包挂载失败，已恢复上一包 ${previous.id}（可再次尝试切换）`)
            return { ok: false, error: mounted.error, steps: mounted.steps, events }
          }
          events.push(`新包挂载失败，且上一包恢复失败：${remount.error}`)
        }
        const next = readState()
        // 仅在「确实卸载过旧包」时记录 deactivate 事件（无旧包的首次激活失败不产生噪音事件）
        if (state.activePack) {
          next.history = [...(next.history ?? []), { event: 'deactivate', packId: state.activePack, at: new Date().toISOString(), note: '切换失败后清空（磁盘已无 hotplug 块）' }].slice(-64)
        }
        next.activePack = null
        next.activeInstall = null
        writeState(next)
        if (removedPreviousBlockOnly) events.push('新包挂载失败，旧包清单不可用，已清空激活状态')
        else if (previous === null && state.activePack) events.push('新包挂载失败，已清空激活状态')
        return { ok: false, error: mounted.error, steps: mounted.steps, events }
      }
      const next = readState()
      // 审计修复（权威 id）：activePack 落盘用 manifest 的权威 id，而非 RPC 传入的
      // 原样 packId——Windows 大小写变体（activate('PACK.X') 经 NTFS 能命中 pack.x 的
      // 清单）此前把 'PACK.X' 写进 state，statusSync 的严格比对随即失配（激活中的包
      // 在 UI 不标 active、deactivate 按钮消失）。
      next.activePack = manifest.id
      // 持久化本次挂载实际安装的 npm 包名（卸载时只撤这些，reused 的预存依赖保留）
      next.activeInstall = { packId: manifest.id, installedNpm: Array.isArray(mounted.installedNpm) ? mounted.installedNpm : [] }
      next.history = [...(next.history ?? []), { event: 'activate', packId: manifest.id, at: new Date().toISOString() }].slice(-64)
      writeState(next)
      return { ok: true, packId: manifest.id, steps: mounted.steps, events, restartNeeded: true }
    }).then(normalizeRpc)
  }

  deactivate() {
    return this.serialize(async () => {
      const corrupted = this.stateCorrupted()
      if (corrupted) return corrupted
      const state = readState()
      if (!state.activePack) return { ok: false, error: '当前没有激活的包' }
      const loaded = loadPackManifest(state.activePack)
      if (loaded.status === 'ok') {
        // 只撤「实际安装/替换」的 npm 包，reused 的预存依赖保留（无损替换）
        const unmounted = await unmountPack(loaded.pack, { installedNpm: state.activeInstall?.installedNpm })
        if (!unmounted.ok) return unmounted
      } else {
        // R3：manifest 缺失/无效时移除旧 patch 块的失败必须显式返回（与 activate 的
        // 同分支一致）——此前返回值被忽略，锁不可得时状态清了但 patch 块还在。
        const removed = removePatchBlock(state.activePack)
        if (!removed.ok) return { ok: false, error: removed.error }
      }
      const next = readState()
      next.history = [...(next.history ?? []), { event: 'deactivate', packId: state.activePack, at: new Date().toISOString() }].slice(-64)
      next.activePack = null
      next.activeInstall = null
      writeState(next)
      return { ok: true, restartNeeded: true }
    }).then(normalizeRpc)
  }

  removePack(packId) {
    return this.serialize(async () => {
      const corrupted = this.stateCorrupted()
      if (corrupted) return corrupted
      const state = readState()
      // 审计修复（大小写加固补齐）：与 packDirExists 的 win32 语义同步——精确比较时
      // removePack('PACK.X') 可越过守卫删掉激活中的 pack.x（state/patch 块仍指向它）。
      const sameId = process.platform === 'win32'
        ? String(state.activePack ?? '').toLowerCase() === String(packId).toLowerCase()
        : state.activePack === packId
      if (sameId) return { ok: false, error: '不能移除激活中的包，先 deactivate' }
      // R3：存在性按 packs/<id> 目录判定（而非 manifest 可解析）——损坏包（清单校验
      // 失败）也允许删除，这是用户清除坏包的恢复路径。
      if (!packDirExists(packId)) return { ok: false, error: `未找到包：${packId}` }
      rmSync(join(packsDir(), packId), { recursive: true, force: true })
      return { ok: true }
    }).then(normalizeRpc)
  }

  check() {
    return checkAsync().then(normalizeRpc)
  }

  marketList(params) {
    return marketListAsync(params).then(normalizeRpc)
  }

  // 上游 v0.9.7 对齐：marketList 只返回列表元数据，详情由 marketDetail 逐条并发补齐
  marketDetail(params) {
    return marketDetailAsync(params).then(normalizeRpc)
  }

  /**
   * AI RPC 公共参数归一化。
   * 安全铁律（key 外传防护）：服务端环境变量里的 key 只发往内置注册表端点——
   * 客户端自定义 baseURL 只有在同时显式携带 apiKey 时才透传；否则丢弃 baseURL，
   * 按注册表（provider 或默认 deepseek）端点解析。防止"无 key 客户端把 baseURL
   * 指向自己服务器，服务端把 env key 用 Bearer 送过去"的外传面。
   */
  aiRpcParams(p) {
    const q = p && typeof p === 'object' ? p : {}
    const hasApiKey = typeof q.apiKey === 'string' && q.apiKey.trim() !== ''
    const out = {
      provider: typeof q.provider === 'string' && q.provider !== '' ? q.provider : undefined,
      model: typeof q.model === 'string' && q.model !== '' ? q.model : undefined,
      apiKey: hasApiKey ? q.apiKey : undefined,
      baseURL: (typeof q.baseURL === 'string' && q.baseURL !== '' && hasApiKey) ? q.baseURL : undefined,
    }
    if (q.timeoutMs !== undefined) {
      const n = Number(q.timeoutMs)
      if (Number.isFinite(n) && n > 0) {
        out.timeoutMs = Math.min(Math.max(Math.round(n), AI_TIMEOUT_MIN_MS), AI_TIMEOUT_MAX_MS)
      }
    }
    return out
  }

  /** AI 失败统一信封：AI 专用错误码 + 意外异常兜底（不裸抛穿透 RPC 传输层）。 */
  aiFail(error) {
    return normalizeRpc({ ok: false, error: typeof error === 'string' ? error : String((error && error.message) || error), code: AI_ERROR_CODE })
  }

  // AI 组装（v5 阶段 5）：需求 → LLM → 权威校验产物。
  // 多平台：默认 deepseek；可传 provider 接内置注册表 / baseURL+apiKey 接任意
  // OpenAI 兼容端点（如 deepseek-v4-flash：provider='opencode'）。
  // 安全：apiKey 仅内存传递（不落盘、不进日志/序列化）；缺省读服务端
  // DSH_AI_API_KEY / DSH_DEEPSEEK_API_KEY / DSH_OPENCODE_API_KEY 等环境变量，
  // env key 只发注册表端点。响应含 {pack, readme, manifest, raw}，绝不含 key。
  aiAssemble(params) {
    const input = params && typeof params === 'object' && typeof params.input === 'string' ? params.input : ''
    return aiAssemble(input, this.aiRpcParams(params))
      .then((r) => {
        if (!r.ok) return this.aiFail(r.error)
        return { ok: true, code: 'OK', data: { pack: r.pack, readme: r.readme, manifest: r.manifest, raw: r.raw }, exitCode: 0 }
      })
      .catch((e) => this.aiFail(e))
  }

  // AI 装配间会话（v5 阶段 5 增强）：人设化对话式装配。
  // 首轮（无 sessionId）= 需求 → 装配；后续轮（带 sessionId）= 对话式增量修改/闲聊，
  // 产物相对上一轮返回 diff（新增/移除/调整）。会话本地持久化（ai-sessions/，
  // 不含任何 key）。persona：maid 小织女仆（默认）/ butler 执事管家 / neko 咪咪猫娘 /
  // assistant 标准助手——只改语气与情绪价值，契约与校验不变；显式传入即切换。
  // 安全：apiKey 仅内存传递；响应（含消息历史）统一脱敏（key→***），绝不含 key。
  aiChat(params) {
    const p = params && typeof params === 'object' ? params : {}
    const input = typeof p.input === 'string' ? p.input : ''
    const opts = {
      ...this.aiRpcParams(p),
      persona: typeof p.persona === 'string' && p.persona !== '' ? p.persona : undefined,
      sessionId: typeof p.sessionId === 'string' && p.sessionId !== '' ? p.sessionId : undefined,
    }
    return aiChatCore(input, opts)
      .then((r) => {
        if (!r.ok) return this.aiFail(r.error)
        return {
          ok: true,
          code: 'OK',
          data: {
            session: r.session,
            reply: r.reply,
            pack: r.pack ?? null,
            readme: r.readme ?? null,
            manifest: r.manifest ?? null,
            diff: r.diff ?? null,
            firstTurn: r.firstTurn === true,
            ...(r.warning ? { warning: r.warning } : {}),
          },
          exitCode: 0,
        }
      })
      .catch((e) => this.aiFail(e))
  }

  // AI 连接测试：服务端视角验证 provider 端点/模型/key（env key 也可测——浏览器
  // 直连既过不了 CORS 也测不到服务端配置）。最小 ping 请求，与装配同一解析链路。
  aiTest(params) {
    return Promise.resolve()
      .then(() => aiTestConnection(this.aiRpcParams(params)))
      .then((r) => {
        if (!r.ok) return this.aiFail(r.error)
        return { ok: true, code: 'OK', data: { provider: r.provider, model: r.model, latencyMs: r.latencyMs }, exitCode: 0 }
      })
      .catch((e) => this.aiFail(e))
  }
}

export { HotplugGateway }
