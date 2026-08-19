# 贡献指南

感谢你参与 DSH-Hotplug-Hub 的开发。

## 开发环境

- Node.js 22.19.0（见 `.nvmrc`）
- pnpm 11.x
- Windows 10/11（桌面 EXE / WebView2）
- 可选：.NET Framework 4.x / Visual Studio（改 C# 时）

## 分支规范

- `main`：稳定可发布分支，受保护
- `develop`：日常集成分支
- `feature/xxx`：功能分支
- `fix/xxx`：修复分支

不要直接往 `main` 推代码，统一走 Pull Request。

## 提交信息

```
feat: 新增 xxx
fix: 修复 xxx
docs: 更新 xxx
refactor: 重构 xxx
test: 增加 xxx 测试
chore: 更新依赖/工具
```

## 本地构建

```bash
# 启动器 CLI
node launcher/index.js assemble example
node launcher/index.js check example
node launcher/index.js heal example

# 编译桌面 EXE
pwsh -File release/build-exe.ps1

# 编译安装程序
pwsh -File installer/build-installer.ps1

# 重新生成开发文档
pwsh -File 开发文档/make-dev-docs.ps1
```

## Pull Request 流程

1. 从 `develop` 切功能分支
2. 完成开发并本地验证
3. 提交 PR 到 `develop`
4. 至少 1 人 Review 通过
5. 合并后由 CI 自动验证

## 代码规范

- JS/Node：2 空格缩进、UTF-8
- C#：4 空格缩进、遵循现有命名
- 文档：中文为主，代码示例用英文标识符

## 安全要求

- 不要把 API Key 提交到仓库
- 本地密钥放 `~/.dsh/.credentials.yaml`
- 改 `launcher` 时不要执行 hotpack/插件里的任意脚本