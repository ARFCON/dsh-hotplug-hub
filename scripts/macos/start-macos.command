#!/usr/bin/env bash
# macOS 启动器入口：同步仓库 -> 组装 -> 打开 GUI（浏览器打开 prototype.html）
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== 同步仓库 =="
# macOS 没有 pwsh 的话可以用 git 直接拉取
git fetch origin 2>/dev/null || true
git pull --ff-only origin main 2>/dev/null || echo "（跳过拉取：无远程或本地未跟踪）"

echo "== 组装示例 =="
node launcher/index.js assemble example || true
node launcher/index.js check example || true

echo "== 打开 GUI =="
open dsh-hotplug-hub/dsh-pack-hub/prototype.html