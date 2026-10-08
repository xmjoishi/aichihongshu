#!/usr/bin/env bash
# Stop only processes recorded by scripts/start.sh and still matching their executable.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/rn-home-pids"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [ ! -f "$PID_FILE" ]; then
  echo -e "${YELLOW}[WARN]${NC} 没有本脚本的启动记录；不会按端口终止未知进程。"
  exit 0
fi

SERVER_PID=none
SERVER_BIN=none
VITE_PID=none
VITE_ENTRY=none
{
  read -r SERVER_PID || true
  read -r SERVER_BIN || true
  read -r VITE_PID || true
  read -r VITE_ENTRY || true
} < "$PID_FILE"

stop_owned() {
  local label="$1" pid="$2" expected="$3" command
  case "$pid" in
    ''|none|*[!0-9]*) return 0 ;;
  esac
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"$expected"*) ;;
    *)
      echo -e "${YELLOW}[WARN]${NC} PID $pid 已不再匹配 $label，保留该进程"
      return 0
      ;;
  esac

  if kill -TERM "$pid" 2>/dev/null; then
    echo -e "${GREEN}[OK]${NC}   已请求停止 $label (PID $pid)"
  fi
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"$expected"*)
      kill -KILL "$pid" 2>/dev/null || true
      echo -e "${YELLOW}[WARN]${NC} $label 未及时退出，已强制结束 PID $pid"
      ;;
  esac
}

stop_owned "Rust API" "$SERVER_PID" "$SERVER_BIN"
stop_owned "Vite" "$VITE_PID" "$VITE_ENTRY"
rm -f "$PID_FILE"
echo "已停止本脚本启动且身份匹配的服务"
