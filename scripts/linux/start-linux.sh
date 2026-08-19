#!/usr/bin/env bash
# Linux 启动器入口：同步仓库 -> 组装 -> 打开 GUI（浏览器打开 prototype.html）
set -euo pipefail
cd "$(dirname "$0")/../.."
git fetch origin 2>/dev/null || true
git pull --ff-only origin main 2>/dev/null || echo "（跳过拉取）"
node launcher/index.js assemble example || true
node launcher/index.js check example || true
xdg-open dsh-hotplug-hub/dsh-pack-hub/prototype.html >/dev/null 2>&1 || true