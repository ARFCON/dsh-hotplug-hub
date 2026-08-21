# assembly — 插件组合

存放插件组合描述。

## 格式
- `assembly/<id>/assembly.json`：hotpack v1 结构（`hotpack: "1.0"`；dshpack 规划格式经 `dshpackToHotpack` 单一桥接转换，见 `dsh-hotplug-hub/dsh-pack-hub/examples/research-pack.dshpack.json`）
- 组合内插件依赖通过 `dsh.bundle.patch: true` 的插件 config 声明（示例见 `dsh-hotplug-hub/examples/research.hotpack.json`）

## 示例
```bash
node launcher/index.js assemble example
```
