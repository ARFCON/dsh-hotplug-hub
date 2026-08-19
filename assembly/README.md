> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。
# assembly — 插件组合

存放插件组合描述。

## 格式
- `assembly/<id>/assembly.json`：hotpack v1 或 dshpack 结构
- `assembly/<id>/resolvedAssembly.json`：AI 修正后的索引（自动生成）

## 示例
```bash
node launcher/index.js assemble example
```