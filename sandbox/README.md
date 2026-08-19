# sandbox

启动器临时 profile 工作区。

- `.sandbox/<id>/`：由 `launcher/core.js` 的 `assemble()` 生成
  - `package.json`
  - `cordis.patch.yml`
  - `logs/run.jsonl`
- 启动时同步到 `~/.dsh/profiles/<id>`
- 该目录由 `.gitignore` 排除，不上传 GitHub；使用者运行安装程序后会自动创建