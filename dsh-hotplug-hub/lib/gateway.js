/**
 * lib/gateway.js — Remote 网关（v5 阶段 3 自 index.js 拆出）
 *
 * R-v5-10（v5 阶段 3）：网关错误序列化统一为 {ok, code, message, exitCode}——
 * error 字符串字段废弃（兼容保留：message 优先，error 回退）；client.js 已适配。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { packsDir } from './core/paths.js'
import { readPackManifest, readState, writeState } from './core/state.js'
import { statusSync, importPackSync, previewPack, checkAsync } from './core/status.js'
import { marketListAsync, marketDetailAsync } from './core/market.js'
import { aiAssemble } from './core/ai.js'
import { mountPack, unmountPack, removePatchBlock, removeBundles, bundlePkgNames } from './core/patch.js'

/** 网关通用失败码（RPC 域，非 CLI ERROR_CODES 表）。 */
export const RPC_ERROR_CODE = 'ERR_HOTPLUG_FAILED'

/**
 * RPC 结果归一化：失败统一 {ok:false, code, message, exitCode}；
 * 兼容保留 error 字段（迁移期 client 可回退读取）。
 * @param {object} result
 * @returns {object}
 */
export function normalizeRpc(result) {
  if (!result || result.ok !== false) return result
  return {
    ...result,
    code: typeof result.code === 'string' ? result.code : RPC_ERROR_CODE,
    message: typeof result.message === 'string' ? result.message : (typeof result.error === 'string' ? result.error : '操作失败'),
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
  }
}

class HotplugGateway extends TypertRemoteService {
  chain = Promise.resolve()

  constructor(ctx) {
    super(ctx, 'dshHotplug')
    // 与 lib/typert.js、lib/client.js REMOTE.descriptors 三处同步。
    const methods = ['status', 'importPack', 'preview', 'activate', 'deactivate', 'removePack', 'check', 'marketList', 'marketDetail', 'aiAssemble']
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
    return normalizeRpc(importPackSync(text))
  }

  preview(packId) {
    return previewPack(packId).then(normalizeRpc)
  }

  activate(packId) {
    return this.serialize(async () => {
      const manifest = readPackManifest(packId)
      if (manifest === null) return { ok: false, error: `未找到包：${packId}（先导入 hotpack）` }
      const state = readState()
      if (state.activePack === packId) return { ok: true, already: true, restartNeeded: false }
      const events = []
      if (state.activePack) {
        const previous = readPackManifest(state.activePack)
        if (previous !== null) {
          const unmounted = await unmountPack(previous)
          if (!unmounted.ok) return unmounted
          events.push(`已卸载上一个包：${previous.name ?? previous.id}（无损替换，记忆与 store 保留）`)
        }
      }
      const mounted = await mountPack(manifest)
      if (!mounted.ok) {
        // 挂载失败：把已经写进去的部分尽量还原（patch 块 + bundles），避免半挂载。
        removePatchBlock(manifest.id)
        removeBundles(bundlePkgNames(manifest))
        return { ok: false, error: mounted.error, steps: mounted.steps }
      }
      const next = readState()
      next.activePack = packId
      next.history = [...(next.history ?? []), { event: 'activate', packId, at: new Date().toISOString() }].slice(-64)
      writeState(next)
      return { ok: true, packId, steps: mounted.steps, events, restartNeeded: true }
    }).then(normalizeRpc)
  }

  deactivate() {
    return this.serialize(async () => {
      const state = readState()
      if (!state.activePack) return { ok: false, error: '当前没有激活的包' }
      const manifest = readPackManifest(state.activePack)
      if (manifest !== null) {
        const unmounted = await unmountPack(manifest)
        if (!unmounted.ok) return unmounted
      } else {
        removePatchBlock(state.activePack)
      }
      const next = readState()
      next.history = [...(next.history ?? []), { event: 'deactivate', packId: state.activePack, at: new Date().toISOString() }].slice(-64)
      next.activePack = null
      writeState(next)
      return { ok: true, restartNeeded: true }
    }).then(normalizeRpc)
  }

  removePack(packId) {
    return this.serialize(async () => {
      const state = readState()
      if (state.activePack === packId) return { ok: false, error: '不能移除激活中的包，先 deactivate' }
      if (readPackManifest(packId) === null) return { ok: false, error: `未找到包：${packId}` }
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

  // AI 组装（v5 阶段 5）：需求 → LLM → 权威校验产物。
  // 多平台：默认 deepseek；可传 provider/baseURL/model 接任意 OpenAI 兼容端点
  // （如 opencode-go/hy3-preview：provider='opencode'）。
  // 安全：apiKey 仅内存传递（不落盘、不进日志/序列化）；缺省读服务端
  // DSH_AI_API_KEY / DSH_DEEPSEEK_API_KEY / DSH_OPENCODE_API_KEY 环境变量。
  // 响应仅含 {ok, pack, readme}，绝不含 key。
  aiAssemble(params) {
    const p = params && typeof params === 'object' ? params : {}
    const input = typeof p.input === 'string' ? p.input : ''
    return aiAssemble(input, {
      provider: typeof p.provider === 'string' && p.provider !== '' ? p.provider : undefined,
      baseURL: typeof p.baseURL === 'string' && p.baseURL !== '' ? p.baseURL : undefined,
      model: typeof p.model === 'string' && p.model !== '' ? p.model : undefined,
      apiKey: typeof p.apiKey === 'string' && p.apiKey.trim() !== '' ? p.apiKey : undefined,
    }).then((r) => {
      if (!r.ok) return normalizeRpc({ ok: false, error: r.error, code: RPC_ERROR_CODE })
      return { ok: true, code: 'OK', data: { pack: r.pack, readme: r.readme }, exitCode: 0 }
    })
  }
}

export { HotplugGateway }
