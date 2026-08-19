# assembly — 插件组合

存放插件组合描述。

## 格式
- `assembly/<id>/assembly.json`：hotpack v1 或 dshpack 结构
- `assembly/<id>/resolvedAssembly.json`：AI 修正后的索引（自动生成）

## 示例
```bash
node launcher/index.js assemble example
```