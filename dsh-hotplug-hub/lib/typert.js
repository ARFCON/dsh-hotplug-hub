/**
 * dsh-hotplug-hub — Typert host manifest（./typert）。
 *
 * Host 侧 typert-loader 扫描已加载插件，导入本文件 TYPERT 对象注册为严格 Remote 定义。
 * 维护铁律（与 dsh-hub 同源）：新增 Remote 方法必须同步三处——
 * 本文件 invocations、lib/gateway.js 的 HotplugGateway methods 列表、lib/client.js 的 REMOTE.descriptors。
 * 本文件不可删除（否则 RPC 404）。
 */
import { z } from 'zod'

const JSON_CODEC = (typeSymbol) => ({
  mode: 'strict',
  typeSymbol,
  schema: z.unknown()
})

const inv = (method, parameters = []) => ({
  id: `dsh-hotplug-hub#dshHotplug/${method}`,
  service: 'dshHotplug',
  namespace: 'dshHotplug',
  method,
  invocation: { kind: 'direct' },
  parameters: parameters.map((name) => ({ name, wire: name, source: 'json', codec: JSON_CODEC('dsh-hotplug-hub/types#Json') })),
  result: JSON_CODEC('dsh-hotplug-hub/types#Json')
})

export const TYPERT = {
  package: 'dsh-hotplug-hub',
  face: 'host',
  schemas: [],
  invocations: [
    inv('status'),
    inv('importPack', ['text']),
    inv('preview', ['packId']),
    inv('activate', ['packId']),
    inv('deactivate'),
    inv('removePack', ['packId']),
    inv('check'),
    inv('marketList', ['params']),
    inv('marketDetail', ['params']),
    inv('aiAssemble', ['params']),
    inv('aiChat', ['params']),
    inv('aiTest', ['params'])
  ],
  model: { services: [], events: [], objects: [] }
}
