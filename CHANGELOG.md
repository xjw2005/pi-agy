# Changelog

## [0.1.0] — 2026-11-16

首个版本：Pi ↔ Google Antigravity（agy）单向委派桥，不含任何第三方后端集成。

### Added

- `ask_agy` 工具：把自包含任务交给 `agy -p --output-format stream-json`，实时回流增量输出，
  返回最终答案与 `conversationId`。
  - 参数：`prompt` / `model` / `mode`(plan|accept-edits|auto) / `thinking|effort` /
    `conversationId` / `cwd` / `digest` / `timeoutMinutes` / `background`
  - 超时：`SIGTERM` → 5s → `SIGKILL`，返回部分输出并标记 `timedOut`
  - 取消：跟随 Pi 的 abort signal
  - 登录失效：识别未授权输出，返回登录指引并置 `isError`
- `background: true`：立即返回 runId，结束时通过 `pi.sendMessage(..., triggerTurn)` 投递结果，无需轮询。
- `/agy` 命令族：状态 / `models` / `ask <文本>` / `doctor` / `help`。
- `lib/agy-core.mjs` 纯函数层：argv 拼装、stream-json 事件解析、模型目录解析、版本解析、
  binary 探测（`AGY_BIN` → PATH → 平台默认目录）、用量与耗时格式化、登录失败识别。
- `tests/agy-core.test.mjs`：16 项 `node --test`，无需 Pi、无需 agy、不联网。
- `scripts/install.ps1` / `install.sh`：幂等装配，缺 `node`/`pi` 明确报错，缺 `agy` 只警告并给指引。
- CI：GitHub Actions，ubuntu + windows × node 20/22 跑语法检查与单测。
- 文档：`README.md`、`docs/PLAN.md`（开发计划与验收基准）、`docs/USAGE.md`（完整链路）。

### Verified (0.1.0 发布前，本机 agy 1.5.9)

- 往返：`ask_agy("Reply with the single word PONG")` → `PONG`，`status SUCCESS`，`took 2.6s`，带 `conversationId`。
- 续聊：第二轮仅凭第一轮 `conversationId` 复述前文数字 `4242`，上下文延续生效。
- 后台：`background: true` 立即返回 runId，模型侧不再轮询。
