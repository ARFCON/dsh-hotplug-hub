> ⚠️ AI 必读：开始任何工作前，请先阅读根目录 `AI_AGENTS.md`，并遵守其中的同步、检查、记忆与更新公告规则。
# sandbox

启动器临时 profile 工作区。

- `.sandbox/<id>/`：由 `launcher/core.js` 的 `assemble()` 生成
  - `package.json`
  - `cordis.patch.yml`
  - `logs/run.jsonl`
- 启动时同步到 `~/.dsh/profiles/<id>`
- 该目录由 `.gitignore` 排除，不上传 GitHub；使用者运行安装程序后会自动创建