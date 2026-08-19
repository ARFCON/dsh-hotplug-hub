#!/usr/bin/env bash
# dsh-hotplug-hub installer（macOS / Linux）
# 用法：./install.sh [profile]   （默认按 desktop → web → headless 自动探测）
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME/plugin-src/dsh-hotplug-hub"

echo "== dsh-hotplug-hub installer =="
echo "Source : $SOURCE"
echo "Target : $TARGET"

command -v pnpm >/dev/null 2>&1 || { echo 'pnpm not found on PATH. Install pnpm first: https://pnpm.io/installation' >&2; exit 1; }

# profile 探测
PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  for candidate in desktop web headless; do
    if [ -f "$DSH_HOME/profiles/$candidate/package.json" ]; then PROFILE="$candidate"; break; fi
  done
fi
PROFILE="${PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
echo "Profile: $PROFILE"

dsh_available=0
command -v dsh >/dev/null 2>&1 && dsh_available=1

# 1. 已存在则备份（保留副本，不做改名）
backup=""
if [ -d "$TARGET" ]; then
  backup="$TARGET.bak-$(date +%Y%m%d%H%M%S)"
  echo "Existing plugin found. Backing up to: $backup"
  cp -R "$TARGET" "$backup"
  rm -rf "$TARGET"
fi

# 2. patch 快照，失败回滚
patch_existed=false
if [ -f "$PATCH_FILE" ]; then
  patch_existed=true
  cp "$PATCH_FILE" "$PATCH_FILE.pre-hotplug-install"
fi
restore() {
  echo "Install failed, restoring previous state..." >&2
  if [ -n "$backup" ] && [ -d "$backup" ]; then
    rm -rf "$TARGET" || true
    cp -R "$backup" "$TARGET" || true
  fi
  if [ "$patch_existed" = true ]; then
    mv -f "$PATCH_FILE.pre-hotplug-install" "$PATCH_FILE" || true
  fi
}
trap restore ERR

# 3. 复制插件源码
mkdir -p "$TARGET"
cp -R "$SOURCE/lib" "$TARGET/"
cp "$SOURCE/package.json" "$TARGET/"
mkdir -p "$TARGET/examples" "$TARGET/docs"
cp -R "$SOURCE/examples/." "$TARGET/examples/" 2>/dev/null || true
cp -R "$SOURCE/docs/." "$TARGET/docs/" 2>/dev/null || true

# 4. 依赖：只依赖 profile 里已有的 @deepseek-ai/dsh-typert-protocol（DSH 自带），无需 pnpm install

# 5. 加入 profile
if [ "$dsh_available" -eq 1 ]; then
  echo "Adding plugin to profile '$PROFILE'..."
  dsh plugin --profile "$PROFILE" add "link:$TARGET"
else
  echo 'dsh not found on PATH. Manual registration:' >&2
  echo "  dsh plugin --profile '$PROFILE' add 'link:$TARGET'" >&2
fi

# 6. 激活行（幂等）
mkdir -p "$PROFILE_DIR"
if [ -f "$PATCH_FILE" ] && grep -q "name: 'dsh-hotplug-hub'" "$PATCH_FILE"; then
  echo 'cordis.patch.yml already contains the dsh-hotplug-hub row.'
else
  printf -- "- insert:\n    - id: dsh-hotplug-hub\n      name: 'dsh-hotplug-hub'\n      config: {}\n" >> "$PATCH_FILE"
  echo 'Added dsh-hotplug-hub row to cordis.patch.yml.'
fi

trap - ERR
rm -f "$PATCH_FILE.pre-hotplug-install"
if [ -n "$backup" ]; then
  echo ''
  echo "Backup of the previous version is kept at: $backup"
fi
echo ''
echo 'Install done. Restart DSH, then open Settings -> Plugins -> Hotplug Hub (热插拔中枢).'
