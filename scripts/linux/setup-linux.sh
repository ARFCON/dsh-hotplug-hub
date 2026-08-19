#!/usr/bin/env bash
# Linux 环境准备：Node / pnpm / 仓库同步
set -euo pipefail
echo "== DSH-Hotplug-Hub Linux 环境准备 =="
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org (>=22)"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm，正在安装..."
  npm install -g pnpm@11
fi
node --version
pnpm --version
echo "环境就绪。"