#!/usr/bin/env bash
# 生成 Linux 启动脚本（GUI 壳：浏览器打开 prototype.html）
set -euo pipefail
cd "$(dirname "$0")/../.."
cat > dist/dsh-hotplug-hub.sh <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
xdg-open dsh-hotplug-hub/dsh-pack-hub/prototype.html
EOF
chmod +x dist/dsh-hotplug-hub.sh
echo "已生成: dist/dsh-hotplug-hub.sh"