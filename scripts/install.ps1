# install.ps1 — 把 pi-agy 装进 Pi（Windows）。幂等，可重复执行。
# 用法： powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$ErrorActionPreference = "Stop"

$RepoRoot  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$GitSource = "git:github.com/xjw2005/pi-agy"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "    $msg" -ForegroundColor Red }

Step "1/3 前置检查"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Err "缺少 node，请先安装 Node.js 20+：https://nodejs.org"
  exit 1
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Err "node $(node --version) 太旧，需要 20+"; exit 1 }
Ok "node $(node --version)"

if (Get-Command pi -ErrorAction SilentlyContinue) {
  Ok "pi 已就绪"
} else {
  Err "缺少 pi：npm i -g @earendil-works/pi-coding-agent"
  exit 1
}

$agyCmd = Get-Command agy -ErrorAction SilentlyContinue
if ($agyCmd) {
  Ok "agy 已就绪：$($agyCmd.Source)"
} else {
  $fallback = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
  if (Test-Path $fallback) {
    Ok "agy 已就绪：$fallback"
    if (-not $env:AGY_BIN) { Warn "建议设置用户环境变量 AGY_BIN=$fallback" }
  } else {
    Warn "未检测到 agy（不阻塞安装）"
    Warn "安装：https://antigravity.google/cli ，或设置 AGY_BIN 指向已有可执行文件"
  }
}

Step "2/3 安装 Pi 扩展"
& pi install $GitSource
if ($LASTEXITCODE -ne 0) {
  Warn "git 源失败，改用本地路径"
  & pi install $RepoRoot
  if ($LASTEXITCODE -ne 0) { Err "安装失败"; exit 1 }
}
Ok "已写入 Pi 配置"

Step "3/3 完成"
Write-Host @"

下一步：
  1. 重启 Pi
  2. 首次使用先授权一次：终端运行 agy，走完 Google 授权后 /exit
  3. Pi 里验证：/agy          （状态）
                /agy doctor   （体检）
                /agy models   （模型目录）
  4. 让模型干活：
     让 agy 用 ask_agy 帮我 review 一下当前改动

"@
