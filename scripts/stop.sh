#!/usr/bin/env bash
# ─────────────────────────────────────────────
# stop.sh — 停止 RedNote Home Assistant
# ─────────────────────────────────────────────
PID_FILE="/tmp/rn-home-pids"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [ -f "$PID_FILE" ]; then
  read -r SERVER_PID VITE_PID < "$PID_FILE"
  for PID in $SERVER_PID $VITE_PID; do
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" && echo -e "${GREEN}[OK]${NC}   已停止进程 $PID"
    fi
  done
  rm -f "$PID_FILE"
else
  echo -e "${YELLOW}[WARN]${NC} 未找到 PID 文件，尝试按端口杀进程..."
  for PORT in 8765 1420; do
    PID=$(lsof -i ":$PORT" -t 2>/dev/null | head -1)
    [ -n "$PID" ] && kill "$PID" && echo -e "${GREEN}[OK]${NC}   已停止端口 $PORT (PID $PID)"
  done
fi
echo "已停止所有服务"
