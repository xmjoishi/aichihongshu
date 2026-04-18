#!/usr/bin/env bash
# ─────────────────────────────────────────────
# start.sh — 一键启动 RedNote Home Assistant
# ─────────────────────────────────────────────
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/rn-home-pids"
LOG_SERVER="/tmp/rn-server.log"
LOG_VITE="/tmp/rn-vite.log"
API_PORT=8765
VITE_PORT=1420

# 颜色
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERR]${NC}  $*"; }

# 注入 node PATH（nvm 环境）
for v in v22.17.1 v20.0.0 v18.20.8; do
  if [ -d "$HOME/.nvm/versions/node/$v/bin" ]; then
    export PATH="$HOME/.nvm/versions/node/$v/bin:$PATH"
    break
  fi
done

check_port() {
  lsof -i ":$1" -t 2>/dev/null | head -1
}

# ── 检查是否已经在运行 ──
if [ -f "$PID_FILE" ]; then
  warn "检测到 PID 文件，服务可能已在运行。先执行 ./stop.sh 再重启，或继续？[y/N] "
  read -r ans
  [ "$ans" != "y" ] && [ "$ans" != "Y" ] && exit 0
fi

echo ""
echo -e "${RED}🍀 RedNote Home Assistant${NC}"
echo "─────────────────────────────"

# ── 启动 FastAPI ──
if PID=$(check_port $API_PORT); then
  warn "端口 $API_PORT 已被进程 $PID 占用，跳过启动后端"
  SERVER_PID=$PID
else
  info "启动 FastAPI 后端 (port $API_PORT)..."
  cd "$PROJECT_ROOT"
  nohup uv run python -m app.server > "$LOG_SERVER" 2>&1 &
  SERVER_PID=$!
  # 等待就绪
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -s "http://127.0.0.1:$API_PORT/health" > /dev/null 2>&1; then
      ok "FastAPI 已就绪 → http://127.0.0.1:$API_PORT  (PID $SERVER_PID)"
      break
    fi
    if [ $i -eq 20 ]; then
      error "FastAPI 启动超时，查看日志: $LOG_SERVER"
      exit 1
    fi
  done
fi

# ── 启动 Vite ──
if PID=$(check_port $VITE_PORT); then
  warn "端口 $VITE_PORT 已被进程 $PID 占用，跳过启动前端"
  VITE_PID=$PID
else
  info "启动 Vite 前端 (port $VITE_PORT)..."
  cd "$PROJECT_ROOT/client"
  nohup pnpm dev > "$LOG_VITE" 2>&1 &
  VITE_PID=$!
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$VITE_PORT/" 2>/dev/null | grep -q "200"; then
      ok "前端已就绪  → http://localhost:$VITE_PORT  (PID $VITE_PID)"
      break
    fi
    if [ $i -eq 20 ]; then
      error "Vite 启动超时，查看日志: $LOG_VITE"
      exit 1
    fi
  done
fi

# 写 PID 文件
echo "$SERVER_PID $VITE_PID" > "$PID_FILE"

echo "─────────────────────────────"
ok "所有服务已启动"
echo -e "  API 文档: ${BLUE}http://127.0.0.1:$API_PORT/docs${NC}"
echo -e "  前端界面: ${BLUE}http://localhost:$VITE_PORT${NC}"
echo -e "  日志: $LOG_SERVER  |  $LOG_VITE"
echo ""

# 自动打开浏览器
open "http://localhost:$VITE_PORT" 2>/dev/null || true
