# launcher — 独立启动器

DSH-Hotplug-Hub 的核心启动器，不依赖 DSH 插件机制。

## 文件
- `core.js`：assemble / checkConflicts / launchAndCapture / selfHeal
- `index.js`：CLI 入口

## 命令

```bash
node launcher/index.js assemble <id>
node launcher/index.js check <id>
node launcher/index.js launch <id>
node launcher/index.js heal <id> [--yes]
node launcher/index.js status <id>
```

## 说明
- `assemble` 读取 `assembly/<id>/assembly.json`
- 生成 `sandbox/.sandbox/<id>/`
- `launch` 同步到 `~/.dsh/profiles/<id>` 并以 `DSH_PROFILE=<id>` 拉起 DSH
- `heal` 默认只预览，`--yes` 才写入建议