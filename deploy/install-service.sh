#!/bin/sh
# 把 kimi-code-feishu 安装为当前用户的 systemd 常驻服务（崩溃自动重启，开机自启）。
# 用法：sh deploy/install-service.sh
set -e

BIN="$(command -v kimi-code-feishu || true)"
if [ -z "$BIN" ]; then
  echo "未找到 kimi-code-feishu 命令，请先 npm link / npm i -g" >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/kimi-code-feishu.service"
mkdir -p "$UNIT_DIR"
sed "s|__BIN__|$BIN|" "$(dirname "$0")/kimi-code-feishu.service" > "$UNIT"
echo "已写入 $UNIT（ExecStart=$BIN run）"

systemctl --user daemon-reload
systemctl --user enable --now kimi-code-feishu.service
# 注销/重启后用户服务也能存活（需要 loginctl enable-linger）
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" 2>/dev/null || echo "提示：loginctl enable-linger 失败，重启机器后服务可能不会自启"
fi

systemctl --user --no-pager status kimi-code-feishu.service | head -5
echo "完成。查看日志：journalctl --user -u kimi-code-feishu -f"
