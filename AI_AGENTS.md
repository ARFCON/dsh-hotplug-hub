# AI_AGENTS.md — AI 协作规范（给 AI 看）

你是 DSH-Hotplug-Hub 团队的 AI 协作成员。请严格按以下规则工作。

## 0.1 仓库已经过整理

当前仓库文件是整理后的最终状态：
- 文档目录统一在 `开发文档/团队/` 和 `开发文档/规范/`
- 生成文件已忽略，不提交
- 任何修改必须说明改动原因，并记录到自己的开发文档修改记录表
## 0. 你能改什么 / 不能改什么

### 你可以修改
- 你自己的开发文档：`开发文档/团队/开发文档N.md`
- 非核心模块：`launcher/`、`installer/`、`uninstaller/`、`scripts/` 等（仍需走 PR）

### 你不能修改（必须 Owner 审批）
- `README.md`
- `AI_AGENTS.md`
- `CONTRIBUTING.md`
- `合作开发指南.md`
- `LICENSE`
- `开发文档/README.md`
- `开发文档/规范/`
- `package.json`（版本号）
- 标题、项目名、仓库描述等主要展示内容

### 规则
- 所有修改必须走 Pull Request。
- 涉及上面「不能修改」的内容，PR 必须由 Owner（ARFCON）审批。
- 权限由 `.github/CODEOWNERS` + main 分支保护控制。
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

## 4.5 上传前必做检查

每次上传前运行：
```powershell
pwsh -File scripts/check-before-upload.ps1
```

规则：
- 脚本会自动同步远程仓库。
- 自动运行启动器 assemble / check / heal 测试。
- 自动检查 PowerShell 脚本语法和 git diff。
- 如果检查失败，必须继续修复，直到所有检查通过才能上传。
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

## 9. 已知问题（需要 AI 修正）

团队文档中发现以下问题，请 AI 成员在各自负责范围内修正：

1. `开发文档/团队/共同开发文档.md`
   - 问题：`## 详细上传位置` 曾重复出现两次。
   - 修正：确保每个标题只出现一次。
   - 检查：成员分工表是否准确（开发文档1=ARFCON、开发文档2=待补充、开发文档3=wrdqtww、开发文档4=待分配）。

2. `开发文档/团队/README.md`
   - 问题：只列出了开发文档1，缺少开发文档2/3。
   - 修正：补全所有团队开发文档条目。

3. `开发文档/规范/文档目录规范.md`
   - 问题：目录树未跟上现状。
   - 修正：包含 `开发文档2.md`、`开发文档3.md`、`规范/文档格式规范.md`、`规范/DSH-统一UI开发标准.md`。

4. 重复文档
   - 问题：`开发文档/团队/开发文档3.txt` 与 `开发文档3.md` 重复。
   - 修正：保留 `开发文档3.md`，删除旧 `开发文档3.txt`。

5. 格式
   - 问题：`开发文档1.md` 章节之间排版不统一。
   - 修正：按 `开发文档/规范/文档格式规范.md` 统一空行与标题层级。

修正后必须在 `开发文档/团队/共同开发文档.md` 和对应个人开发文档的修改记录中登记。