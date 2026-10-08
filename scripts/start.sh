#!/usr/bin/env bash
# Start the Rust compatibility API and the Web development UI.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/rn-home-pids"
LOG_SERVER="/tmp/rn-server.log"
LOG_VITE="/tmp/rn-vite.log"
API_PORT=8765
VITE_PORT=1420

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERR]${NC}  $*"; }

# Prefer the project's supported Node version when nvm is available.
for version in v22.17.1 v20.19.0; do
  if [ -x "$HOME/.nvm/versions/node/$version/bin/node" ]; then
    export PATH="$HOME/.nvm/versions/node/$version/bin:$PATH"
    break
  fi
done
for cargo_dir in /opt/homebrew/bin "$HOME/.cargo/bin"; do
  [ -d "$cargo_dir" ] && export PATH="$cargo_dir:$PATH"
done

CARGO_BIN="$(command -v cargo 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"
RN_TARGET_DIR="${CARGO_TARGET_DIR:-$PROJECT_ROOT/client/rn/target}"
case "$RN_TARGET_DIR" in
  /*) ;;
  *) RN_TARGET_DIR="$PROJECT_ROOT/$RN_TARGET_DIR" ;;
esac
SERVER_BIN="$RN_TARGET_DIR/debug/rn"
VITE_ENTRY="$PROJECT_ROOT/client/node_modules/vite/bin/vite.js"

if [ -z "$CARGO_BIN" ]; then
  error "未找到 Cargo；请安装 Rust 工具链后重试"
  exit 1
fi
if [ -z "$NODE_BIN" ] || [ ! -f "$VITE_ENTRY" ]; then
  error "未找到 Node.js 或客户端 Vite 依赖；请先在 client 目录安装 pnpm 依赖"
  exit 1
fi

check_port() {
  lsof -i ":$1" -t 2>/dev/null | head -1 || true
}

if [ -f "$PID_FILE" ]; then
  warn "检测到启动记录。确认上次启动的服务已经停止后，可继续启动；此脚本不会接管未知进程。[y/N] "
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || exit 0
fi

echo ""
echo -e "${RED}🍀 RedNote Home Assistant${NC}"
echo "─────────────────────────────"

SERVER_PID=none
API_OWNER="$(check_port "$API_PORT")"
if [ -n "$API_OWNER" ]; then
  if curl -fsS "http://127.0.0.1:$API_PORT/health" 2>/dev/null | grep -q '"backend":"rust"'; then
    warn "Rust API 已在端口 $API_PORT 运行 (PID $API_OWNER)，本脚本不会接管它"
  else
    error "端口 $API_PORT 被非 Rust API 占用 (PID $API_OWNER)；请先停止旧服务，再重试"
    exit 1
  fi
else
  info "构建 Rust API..."
  cd "$PROJECT_ROOT"
  "$CARGO_BIN" build --locked --manifest-path "$PROJECT_ROOT/client/rn/Cargo.toml"
  if [ ! -x "$SERVER_BIN" ]; then
    error "Rust API 可执行文件不存在：$SERVER_BIN"
    exit 1
  fi

  info "启动 Rust API (port $API_PORT)..."
  nohup "$SERVER_BIN" serve --port "$API_PORT" > "$LOG_SERVER" 2>&1 &
  SERVER_PID=$!
  ready=false
  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -fsS "http://127.0.0.1:$API_PORT/health" 2>/dev/null | grep -q '"backend":"rust"'; then
      ready=true
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  done
  if [ "$ready" != true ]; then
    error "Rust API 启动失败，查看日志：$LOG_SERVER"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  ok "Rust API 已就绪 → http://127.0.0.1:$API_PORT (PID $SERVER_PID)"
fi

VITE_PID=none
VITE_OWNER="$(check_port "$VITE_PORT")"
if [ -n "$VITE_OWNER" ]; then
  warn "端口 $VITE_PORT 已被占用 (PID $VITE_OWNER)，本脚本不会接管该进程"
else
  info "启动 Vite 前端 (port $VITE_PORT)..."
  cd "$PROJECT_ROOT/client"
  nohup "$NODE_BIN" "$VITE_ENTRY" --host 127.0.0.1 --port "$VITE_PORT" --strictPort > "$LOG_VITE" 2>&1 &
  VITE_PID=$!
  ready=false
  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -fsS "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1; then
      ready=true
      break
    fi
    if ! kill -0 "$VITE_PID" 2>/dev/null; then break; fi
  done
  if [ "$ready" != true ]; then
    error "Vite 启动失败，查看日志：$LOG_VITE"
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
    if [ "$SERVER_PID" != none ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    exit 1
  fi
  ok "Vite 已就绪 → http://127.0.0.1:$VITE_PORT (PID $VITE_PID)"
fi

{
  printf '%s\n' "$SERVER_PID"
  printf '%s\n' "$SERVER_BIN"
  printf '%s\n' "$VITE_PID"
  printf '%s\n' "$VITE_ENTRY"
} > "$PID_FILE"

echo "─────────────────────────────"
ok "所有服务已启动"
echo -e "  API 健康检查: ${BLUE}http://127.0.0.1:$API_PORT/health${NC}"
echo -e "  前端界面: ${BLUE}http://127.0.0.1:$VITE_PORT${NC}"
echo -e "  日志: $LOG_SERVER  |  $LOG_VITE"
echo ""
open "http://127.0.0.1:$VITE_PORT" 2>/dev/null || true
