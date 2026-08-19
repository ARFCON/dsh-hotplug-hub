#!/usr/bin/env bash
# 生成简易 macOS .app（用浏览器打开 prototype.html 作为 GUI 壳）
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="dist/DSH-Hotplug-Hub.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>DSH-Hotplug-Hub</string>
  <key>CFBundleDisplayName</key><string>DSH 热插拔中枢</string>
  <key>CFBundleIdentifier</key><string>com.dsh.hotplug-hub</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/launcher" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/../../../../.."
open dsh-hotplug-hub/dsh-pack-hub/prototype.html
EOF
chmod +x "$APP/Contents/MacOS/launcher"

echo "已生成: $APP"
echo "可执行: open $APP"