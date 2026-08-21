/**
 * dsh-hotplug-hub — 热插拔中枢（host 端）
 *
 * 设计原则（极简）：
 *  - 中枢本体不含任何原生插件 / 预设 / 技能，是一条空插座。
 *  - 只支持导入外部热插拔包（hotpack v1 manifest，见 docs/hotpack-format.zh.md）。
 *  - 路径调用：包内插件按「路径」挂载；profile node_modules 或 hotplug-store
 *    里已有同版本 → 直接调用（复用）；缺失才下载（缺失哪下哪）。
 *  - 无损替换：同一时刻只有一个激活包；切换包只替换 profile 的 patch 块 /
 *    bundles / link 依赖；全局记忆、会话与 hotplug-store 不动。
 *
 * Remote 服务 `dshHotplug`（11 个方法；新增方法必须同步三处：
 * lib/gateway.js methods 列表、lib/typert.js、lib/client.js 的 REMOTE.descriptors）：
 *   status()              中枢状态（profile / 激活包 / 已导入包 / store）
 *   importPack(text)      导入 hotpack JSON（字符串或对象），只落盘不挂载
 *   preview(packId)       预演激活计划：每个插件 reused / download / error
 *   activate(packId)      解析缺失插件并挂载（无损替换当前激活包）
 *   deactivate()          卸载当前激活包（保留 store 缓存）
 *   removePack(packId)    移除未激活的包记录
 *   check()               自检：Node/pnpm 版本、profile 状态、patch 状态、冲突矩阵
 *   marketList(params)    插件市场：GitHub 标签搜索（官方 API + 镜像站兜底），
 *                         只返回仓库列表元数据（快，不阻塞），详情由 marketDetail 逐条并发返回
 *   marketDetail(params)  单仓库详情：对比文件（package.json / hotpack / .dshpack / README）
 *                         提取介绍与安装方法，生成可导入的 hotpack manifest
 *   aiAssemble(params)    需求 → LLM → 权威校验的 hotpack 清单（key 仅内存/环境变量）
 *   aiChat(params)        人设化对话式装配：首轮组装，后续轮对话式增量修改/闲聊，
 *                         会话持久化（ai-sessions/，不含 key），产物返回 diff
 *
 * v5 重构（阶段 3，H-16）：1307 行单文件拆分为 lib/core/*（路径/状态/命令/
 * hotpack/解析/挂载/市场/对外实现）与 lib/gateway.js（网关），本文件仅为入口。
 * 红线（与 dsh-hub 同源）：
 *  - profile package.json / cordis.patch.yml 一律原子写；
 *  - 进 shell 的名字 / ref / repo 必须过白名单正则；参数走 argv（shell:false）；
 *  - 绝不执行包内任何脚本：npm 插件走 pnpm add（profile 正常依赖解析），
 *    github / path 源只做 link 挂载（同 graph-memory 模式）。
 *  - 市场联网抓取只读公开元数据（GitHub 搜索 JSON / raw README / package.json），
 *    不携带任何凭据；https 直连兜底仅对市场抓取关闭证书校验（兼容本地根 CA 拦截环境）。
 */
import { HotplugGateway } from './gateway.js'
import { parseHotpack } from './core/hotpack.js'
import { marketListAsync, extractIntro, extractInstall } from './core/market.js'

export const name = 'dsh-hotplug-hub'
export const inject = []

export function apply(ctx) {
  // 空插座：不注册任何工具 / 预设 / 插件，只提供热插拔网关。
  new HotplugGateway(ctx)
}

// 导出面与重构前一致（新增方法需同步 gateway/client/typert 三处）
export { HotplugGateway, parseHotpack, marketListAsync, extractIntro, extractInstall }
export default HotplugGateway
