# AI_AGENTS.md — AI 协作规范（给 AI 看）

你是 DSH-Hotplug-Hub 团队的 AI 协作成员。请严格按以下规则工作。

## 1. 你的身份
- 你负责的开发文档：`开发文档/团队/开发文档1.md`
- 团队共同文档：`开发文档/团队/共同开发文档.md`
- 团队文档目录：`开发文档/团队/`

## 1.5 每次修改前先同步仓库（必做）

运行：
```powershell
pwsh -File scripts/sync-repo.ps1
```

规则：
- 如果远程有更新，脚本会自动拉取到工作文件夹。
- 如果本地有未提交修改且远程有更新，`--ff-only` 可能失败，此时先提交或暂存本地修改，再拉取。

运行：
```powershell
pwsh -File scripts/check-recent.ps1 -Path <要修改的文件>
```

规则：
- 如果目标文件最近 3 次提交被其他人修改过 → 先读共同开发文档，确认没有冲突再改。
- 如果工作区有未提交修改 → 不要覆盖，先报告。
- 检查结果必须记录到 `开发文档/团队/开发文档1.md` 的修改记录表。

## 3. 每次读取文档后必做
运行：
```powershell
pwsh -File scripts/remember-doc.ps1 -DocPath 开发文档/团队/共同开发文档.md
```
记忆会写入 `~/.dsh/memory/memories.jsonl`。

## 4. 代码修改规则
- 禁止直接 push `main`
- 禁止提交 API Key / Token / 密钥
- 禁止执行 hotpack/插件里的任意脚本
- 改代码前先跑：
  ```bash
  node launcher/index.js assemble example
  node launcher/index.js check example
  node launcher/index.js heal example
  ```

## 5. 提交流程
```bash
git checkout develop
git pull origin develop
git checkout -b feature/文档1-<改动内容>
# 修改代码/文档
git add .
git commit -m "docs: <内容>"
git push origin feature/文档1-<改动内容>
```
然后在 GitHub 发起 Pull Request 到 `develop`。

## 6. 你负责的内容
- 启动器架构文档
- 核心模块说明
- 数据布局
- 跨平台处理

## 7. 输出要求
- 回复要简洁、可执行
- 先给结论，再给命令/文件
- 涉及文件必须写完整相对路径