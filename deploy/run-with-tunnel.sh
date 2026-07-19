#!/bin/bash
# 带 cloudflared 公网隧道启动桥：dashboard 经 trycloudflare 临时域名暴露，
# 隧道 URL 自动注入 KCF_DASHBOARD_PUBLIC_URL，审批/提问卡片里的「查看实时输出」即可公网打开。
#
# 用法：bash deploy/run-with-tunnel.sh
# 注意：quick tunnel 域名每次启动都会变；要固定域名需用 Cloudflare 账号建 named tunnel。
set -euo pipefail

CLOUDFLARED="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
KCF="$(command -v kimi-code-feishu || true)"
if [ -z "$KCF" ]; then
  KCF="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
fi

LOG="$(mktemp -t cloudflared.XXXXXX.log)"
"$CLOUDFLARED" tunnel --url http://127.0.0.1:17772 --no-autoupdate > "$LOG" 2>&1 &
CF_PID=$!
cleanup() { kill "$CF_PID" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

# 等 cloudflared 打印 trycloudflare 域名（最多 15s）
URL=""
for _ in $(seq 1 30); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done
if [ -z "$URL" ]; then
  echo "cloudflared 未能拿到公网域名，日志：" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

echo "🌐 Dashboard 公网地址：$URL"
export KCF_DASHBOARD_PUBLIC_URL="$URL"
exec $KCF run
