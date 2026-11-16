#!/usr/bin/env bash
# install.sh — 把 pi-agy 装进 Pi（macOS / Linux）。幂等，可重复执行。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_SOURCE="git:github.com/xjw2005/pi-agy"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }
err()  { printf '    \033[31m%s\033[0m\n' "$1"; }

step "1/3 前置检查"
command -v node >/dev/null 2>&1 || { err "缺少 node，请先安装 Node.js 20+"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then err "node $(node --version) 太旧，需要 20+"; exit 1; fi
ok "node $(node --version)"

if command -v pi >/dev/null 2>&1; then ok "pi 已就绪"; else err "缺少 pi：npm i -g @earendil-works/pi-coding-agent"; exit 1; fi

if command -v agy >/dev/null 2>&1; then
  ok "agy 已就绪：$(command -v agy)"
else
  warn "未检测到 agy（不阻塞安装）"
  warn "安装：curl -fsSL https://antigravity.google/cli/install.sh | bash"
  warn "已有可执行文件时可设：export AGY_BIN=/绝对路径/agy"
fi

step "2/3 安装 Pi 扩展"
if pi install "$GIT_SOURCE"; then
  ok "$GIT_SOURCE"
else
  warn "git 源失败，改用本地路径"
  pi install "$REPO_ROOT"
  ok "$REPO_ROOT"
fi

step "3/3 完成"
cat <<'EOF'

下一步：
  1. 重启 Pi
  2. 首次使用先授权一次：终端运行 `agy`，走完 Google 授权后 /exit
  3. Pi 里验证：/agy          （状态）
                /agy doctor   （体检）
                /agy models   （模型目录）
  4. 让模型干活：
     让 agy 用 ask_agy 帮我 review 一下当前改动

EOF
