# 开发计划 — pi-agy

> 本文件是「新项目启动硬门禁」的两项产物之一：开发计划。另一项是测试基准，见文末与
> `tests/agy-core.test.mjs`。

## 1. 目标

Pi 与 Google Antigravity（`agy`）之间只要一条通道就能配合干活：

- Pi 能把一个自包含任务整块交给 agy，并拿回结果（`ask_agy`）
- agy 在自己的 agent loop 里读文件、改代码、执行命令，能力边界不因桥接而缩小
- 同一会话可续聊（`conversationId`），长任务可后台跑
- 人类在 Pi 里能看状态、列模型、体检（`/agy`）

明确**不做**的事：

- 不做 provider（不把 agy 伪装成 Pi 的模型）；模型选择、额度、登录全归 agy
- 不内嵌任何其他后端集成；仓库里只允许出现 agy 一条通道
- 不写中转服务、不抓 Cookie、不代管凭据

## 2. 范围

| 层 | 内容 | 是否交付 |
|---|---|---|
| 工具 | `ask_agy`：prompt / model / mode / thinking / conversationId / cwd / digest / timeoutMinutes / background | 是 |
| 命令 | `/agy`、`/agy models`、`/agy ask`、`/agy doctor` | 是 |
| 纯函数层 | argv 拼装、stream-json 事件解析、模型目录解析、binary 定位、格式化 | 是 |
| 装配 | `scripts/install.ps1` / `install.sh` | 是 |
| CI | GitHub Actions：ubuntu + windows 跑 `npm test` | 是 |
| provider / 代理 / 凭据管理 | — | 否（永不做） |

## 3. 里程碑

| M | 内容 | 完成判据 |
|---|---|---|
| M1 纯函数层 | `lib/agy-core.mjs` | 16 项单测全绿，零 I/O 依赖 |
| M2 委派链路 | `extensions/agy-bridge.ts` 的 `ask_agy` | `PONG` 往返成功，结果带 `conversationId` |
| M3 续聊与后台 | conversationId 透传、`background: true` 投递 | 二次调用复述前文成功；后台任务启动即返回 |
| M4 人类侧命令 | `/agy*` 四个子命令 | 状态/模型/体检均可读输出 |
| M5 装配与发布 | 安装脚本、CI、README、CHANGELOG，推送 GitHub | 干净环境 `pi install git:...` 即用 |

M1–M5 全部完成，版本 `0.1.0`。

## 4. 技术选型

| 决定 | 理由 |
|---|---|
| TS 扩展 + 纯 JS 核心（`.mjs`） | 扩展需要 typebox 声明参数；核心必须能脱离 Pi 被 `node --test` 直接跑 |
| `agy -p --output-format stream-json` | 唯一同时给出增量文本、`conversation_id`、用量与状态的输出格式 |
| 子进程 + 行缓冲解析 | 不引入 ACP/MCP 依赖，桥面最小，故障面最小 |
| 超时 + SIGTERM→SIGKILL 兜底 | agy 卡死不能拖死 Pi 会话 |
| 不开 `--dangerously-skip-permissions` | 权限交给 agy 自己的 mode，桥不替用户做安全决定 |
| 工具名 `ask_agy` | 与既有 `ask_antigravity` / `AskAntigravity` 系列不撞名，可共存 |

## 5. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| agy 改输出格式 | 事件解析失效 | 解析器对未知事件降级为纯文本，单测锁住已知三种事件 |
| agy 未安装 / 未登录 | 工具不可用 | `findAgyBinary` 明确报错 + 安装/登录提示，`/agy doctor` 自诊断 |
| 长任务占住会话 | 体验差 | `background: true` 后台投递；前台有 `timeoutMinutes` |
| 模型 id 漂移 | 选错模型 | `model` 只透传不校验，`/agy models` 以 agy 为准 |
| 与第三方 agy 桥共存 | 工具重复注册 | 命名空间独立（`ask_agy` / `/agy`），README 说明可共存 |

## 6. 测试基准（可跑起来的最小验证）

```bash
npm run verify          # 语法检查 + 16 项纯函数单测，无需 Pi / 无需 agy
```

集成验证（需要本机已授权 agy）：

```bash
# 1) 工具往返
pi -e ./extensions/agy-bridge.ts -nbt \
   -p "Call ask_agy with prompt 'Reply with the single word PONG', then quote the result." --mode text

# 2) 续聊
pi -e ./extensions/agy-bridge.ts -nbt -p "…两轮，第二轮用第一轮返回的 conversationId…" --mode text

# 3) 后台
pi -e ./extensions/agy-bridge.ts -nbt \
   -p "Call ask_agy with background=true …, then print started." --mode text
```

三条集成验证在 `0.1.0` 发布前均已通过，输出见 CHANGELOG 对应条目。
