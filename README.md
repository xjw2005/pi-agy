# pi-agy

把 **Google Antigravity**（`agy` 命令，Gemini CLI 同源）接进 [Pi](https://pi.dev)，两个智能体在同一台机器上分工干活：Pi 负责编排，agy 负责跑。

- 模型侧：`ask_agy` 工具，Pi 一句话把整块任务交给 agy；agy 用自己的 agent loop 读文件、改代码、跑命令，跑完把答案交回来
- 人类侧：`/agy` 命令，随时看状态、列模型、体检、直接甩一句话给 agy
- 不掺任何中转服务：用你自己已登录的 `agy` 账号与额度，没有 API Key、没有代理、没有第三方桥

装完重启 Pi 就能用。整个仓库只做一件事：让 Pi 和 agy 配合。

---

## 它到底怎么配合

```
你 → Pi（编排、写代码、守上下文）
        │  ask_agy(prompt, mode, model, conversationId, background)
        ▼
     agy（自己的 agent loop：读 / 改 / 跑命令）
        │  最终答案 + conversationId + 用量
        ▼
Pi 拿到结果继续干；需要同一话题再聊，把 conversationId 传回去
```

三种模式，按需选：

| mode | agy 做什么 | 什么时候用 |
|---|---|---|
| `accept-edits`（默认） | 直接改文件、执行命令 | 派活让它真干 |
| `plan` | 只出方案，不动手 | 想先看它打算怎么做 |
| `auto` | agy 自己判断 | 不确定时交给它 |

`background: true` → 立刻返回，agy 在后台继续跑，答案稍后以消息形式出现（不用轮询）。

---

## 安装

### 一键（推荐）

Windows：

```powershell
git clone https://github.com/xjw2005/pi-agy.git
cd pi-agy
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

macOS / Linux：

```bash
git clone https://github.com/xjw2005/pi-agy.git
cd pi-agy
bash scripts/install.sh
```

脚本只做三件事（幂等，可重复跑）：检查 `node` / `pi` / `agy` → `pi install git:github.com/xjw2005/pi-agy` → 打印首次登录提示。

### 手动

```bash
pi install git:github.com/xjw2005/pi-agy
```

然后重启 Pi。

### 首次授权（一次）

```bash
agy            # 走 Google 授权，完成后 /exit
```

---

## 用起来

### Pi 里直接说人话

```
让 agy 帮我 review 一下 lib/ 下的改动，重点看错误处理
```

模型会调 `ask_agy`。你也可以自己交代细节：

```
用 ask_agy，mode=plan，model=claude-sonnet-4-6，看看这个仓库的测试覆盖哪里缺
```

### 命令

```
/agy                 状态：binary、版本、工作目录、后台任务数
/agy models          列 agy 可用模型
/agy ask <一句话>     直接把这句话交给 agy，结果贴回会话
/agy doctor          体检：binary、版本、登录、会话目录、AGY_BIN
```

### 结果里的 conversationId

每次返回尾部都有一行 `conversationId: ...`。想让 agy 接着刚才的上下文聊，把它作为 `conversationId` 传回去，agy 不用重新理解背景。

---

## 配置

全部走环境变量，没有配置文件要改：

| 变量 | 作用 |
|---|---|
| `AGY_BIN` | `agy` 不在 PATH 时指到可执行文件绝对路径 |
| `AGY_HOME` | 自定义 agy 数据目录（默认 `~/.gemini`） |

模型选择：`model` 传 agy 的模型 id（`/agy models` 能看到的），或只传档位词（如 `flash high`）。`thinking` / `effort` 传 `minimal|low|medium|high|xhigh|max`，agy 只认三档，会自动收拢。

---

## 排障

| 现象 | 处理 |
|---|---|
| `ask_agy` 说 agy 未安装 | 装 Antigravity CLI，或设 `AGY_BIN` 指向可执行文件 |
| 返回「未登录」 | 终端跑一次 `agy` 完成授权，然后 `/exit` |
| `/agy models` 空 | 同上；`/agy doctor` 能看到版本与会话目录 |
| 想让 agy 别动文件 | `mode: "plan"` |
| 长任务老超时 | 调大 `timeoutMinutes`（默认 30，上限 720） |

---

## 目录结构

```
extensions/agy-bridge.ts    Pi 扩展：ask_agy 工具 + /agy 命令 + 后台任务投递
lib/agy-core.mjs            纯函数层：argv 拼装、事件解析、模型目录、binary 定位、格式化
tests/agy-core.test.mjs     node --test，无需 Pi、无需 agy、不联网
scripts/install.ps1|sh      一键装配
config/                     settings 片段
docs/PLAN.md                开发计划与验收基准
docs/USAGE.md               完整链路、参数、验证步骤
```

---

## 测试

```bash
npm test      # 16 项纯函数单测，秒级，无副作用
npm run check # 语法检查
npm run verify
```

---

## License

MIT
