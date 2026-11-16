# USAGE — pi-agy 完整链路

## 0. 三层结构

```
extensions/agy-bridge.ts   Pi 侧的桥：注册 ask_agy + /agy，管理子进程与结果塑形
lib/agy-core.mjs           纯函数：不碰 I/O，全部可单测
tests/agy-core.test.mjs    契约测试，node --test 直接跑
```

桥只做一件事：把 `ask_agy` 的参数翻译成 `agy` 的 argv，读它的 `stream-json` 输出，
把最终答案 + 会话句柄交回 Pi。判断、执行、改文件都在 agy 里发生。

## 1. ask_agy 参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `prompt` | string（必填） | — | 自包含任务说明。agy 看不到本会话，事实、路径、约束都要写进来 |
| `model` | string | agy 默认 | agy 模型 id（`/agy models`），也可只给档位词如 `flash high` |
| `mode` | `accept-edits` \| `plan` \| `auto` | `accept-edits` | 执行模式 |
| `thinking` / `effort` | `minimal…max` | agy 默认 | 同义，二选一；收拢到 agy 的 low/medium/high |
| `conversationId` | string | — | 续聊同一 agy 会话 |
| `cwd` | string | 会话 cwd | 工作目录，不存在则回落 |
| `digest` | boolean | false | 要求 agy 给摘要而非整文件 |
| `timeoutMinutes` | number | 30 | 硬超时，上限 720 |
| `background` | boolean | false | 后台跑，结果稍后作为消息投递 |

返回体末尾固定带一行 `conversationId: <uuid>`（agy 报告了才有），
以及 `status / model / took / 用量` 组成的摘要行。

## 2. 命令

```
/agy                 状态：binary、版本、工作区、后台任务数
/agy models          实时 `agy models`，附 id 与人类可读名
/agy ask <文本>       前台跑一次，结果以消息形式贴回会话（不触发模型回复）
/agy doctor          体检：binary、版本、登录、会话目录、AGY_BIN、缓存模型数
/agy help            命令速查
```

## 3. 环境变量

| 变量 | 作用 |
|---|---|
| `AGY_BIN` | 显式指定 `agy` 可执行文件；优先级最高 |
| `AGY_HOME` | agy 数据目录，仅 `/agy doctor` 展示会话路径时使用 |

`findAgyBinary` 的探测顺序：`AGY_BIN` → `PATH`（Windows 含 `.exe/.cmd/.bat`）→
平台默认目录（Windows `%LOCALAPPDATA%\agy\bin`，类 Unix `~/.local/bin`、`/usr/local/bin`、
`/opt/homebrew/bin`）。

## 4. stream-json 契约

agy 每行一个 JSON 事件，桥只认三种，其余降级为文本：

| event | 用途 |
|---|---|
| `init` | 拿到 `conversation_id`、`cwd`、`permission_mode` |
| `step_update` | `text_delta` 累积成增量输出，实时推给 TUI |
| `result` | 终态：`status`、`response`、`duration_seconds`、`usage` |

未知或损坏的行不会丢内容：直接当纯文本追加。这条降级路径由单测锁住
（`parseAgyLine` 对 `plain text` / `{broken json` 返回 `null`）。

## 5. 生命周期与故障

- **超时**：`timeoutMinutes` 到点先 `SIGTERM`，5s 后 `SIGKILL`，返回部分输出并标记 `timedOut`
- **取消**：Pi 侧 abort（用户中断）→ 同一条 kill 路径，标记 `aborted`
- **登录失效**：stderr/文本命中 `not logged in` / `401` 等 → 返回登录指引并置 `isError`
- **二进制缺失**：不 spawn，直接给安装指引
- **后台**：`background: true` 立刻返回 runId；结束时通过 `pi.sendMessage(..., triggerTurn)`
  投递，模型无需轮询

## 6. 验证步骤

```bash
npm run verify
```

```bash
# 往返
pi -e ./extensions/agy-bridge.ts -nbt -p "Call ask_agy with prompt 'Reply with the single word PONG'." --mode text

# 续聊（两轮，第二轮传第一轮的 conversationId）
pi -e ./extensions/agy-bridge.ts -nbt -p "<见 docs/PLAN.md 第 6 节>" --mode text
```

预期：第一轮返回 `PONG` 与 `conversationId`；第二轮仅凭该 id 复述前文，证明续聊生效。

## 7. 与第三方 agy 桥共存

工具名 `ask_agy`、命令名 `/agy`，均不与 `@estebanforge/pi-antigravity-bridge`
（`AskAntigravity`）冲突。两者可同时安装；若只想保留本仓库，执行：

```bash
pi remove npm:@estebanforge/pi-antigravity-bridge
```
