/**
 * Pi extension: ask_agy — hand a self-contained task to Google Antigravity.
 *
 * `agy` is the Antigravity CLI (the Gemini CLI lineage). It runs its OWN tool
 * loop: it can read, write, edit and execute commands inside the workspace,
 * then returns the final answer. This extension is only the pipe:
 *
 *   pi tool call  ->  `agy -p ... --output-format stream-json`  ->  one result
 *
 * No provider, no proxy, no server, no third-party bridge: your own `agy`
 * login and quota do the work. Everything I/O-free lives in lib/agy-core.mjs
 * so the whole contract is unit-tested without Pi or agy installed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_TIMEOUT_MINUTES,
  INSTALL_HINT,
  LOGIN_HINT,
  MAX_TIMEOUT_MINUTES,
  agyConversationsDir,
  applyDigest,
  buildAgyArgs,
  clampTimeoutMinutes,
  detectAuthFailure,
  findAgyBinary,
  formatRunFooter,
  normalizeMode,
  parseAgyLine,
  parseAgyVersion,
  parseModelList,
  parseModelSpec,
  summarizePrompt,
  toAgyEffort,
  truncate,
} from "../lib/agy-core.mjs";

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "agy-bridge");
const MAX_OUTPUT_CHARS = 60_000;
const PARTIAL_UPDATE_MS = 250;
const STATUS_TAIL_CHARS = 120;
const KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// binary / config helpers
// ---------------------------------------------------------------------------

function resolveBinary(): string | undefined {
  return findAgyBinary({ env: process.env, platform: process.platform, homedir: os.homedir() });
}

function defaultCwd(candidate?: string): string {
  if (typeof candidate === "string" && candidate.trim()) {
    const resolved = path.resolve(candidate.trim());
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      /* fall through to the session cwd */
    }
  }
  return process.cwd();
}

function ensureStateDir(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* diagnostics only */
  }
}

// ---------------------------------------------------------------------------
// one agy run
// ---------------------------------------------------------------------------

type Usage = Record<string, number> | undefined;

interface RunOutcome {
  text: string;
  stderr: string;
  conversationId?: string;
  status?: string;
  durationSeconds?: number;
  usage?: Usage;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  authProblem: boolean;
  binaryMissing?: boolean;
}

interface RunOptions {
  prompt: string;
  model?: string;
  effort?: string;
  mode: string;
  cwd: string;
  conversationId?: string;
  digest?: boolean;
  timeoutMinutes?: number;
  binary: string;
  signal?: AbortSignal;
  onText?: (partial: string) => void;
  onStatus?: (line: string) => void;
}

function runAgy(options: RunOptions): Promise<RunOutcome> {
  const timeoutMinutes = clampTimeoutMinutes(options.timeoutMinutes);
  const args = buildAgyArgs({
    prompt: applyDigest(options.prompt, options.digest),
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    conversationId: options.conversationId,
    outputFormat: "stream-json",
  });

  return new Promise<RunOutcome>((resolve) => {
    let stdoutBuffer = "";
    let text = "";
    let stderr = "";
    let conversationId = options.conversationId;
    let status: string | undefined;
    let durationSeconds: number | undefined;
    let usage: Usage;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let lastPartialAt = 0;

    let child: ReturnType<typeof spawn> | undefined;

    const emitPartial = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPartialAt < PARTIAL_UPDATE_MS) return;
      lastPartialAt = now;
      if (!options.onText || !text) return;
      options.onText(text);
    };

    const finish = (exitCode: number | null, spawnError?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (spawnError) {
        const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
        resolve({
          text: "",
          stderr: message,
          conversationId,
          status,
          durationSeconds,
          usage,
          exitCode,
          timedOut,
          aborted,
          authProblem: false,
        });
        return;
      }
      resolve({
        text: text.trim(),
        stderr: stderr.trim(),
        conversationId,
        status,
        durationSeconds,
        usage,
        exitCode,
        timedOut,
        aborted,
        authProblem: detectAuthFailure(`${stderr}\n${text}`),
      });
    };

    const killChild = () => {
      if (!child) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS).unref?.();
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMinutes * 60_000);
    timeoutTimer.unref?.();

    if (options.signal) {
      if (options.signal.aborted) {
        aborted = true;
        finish(null);
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      child = spawn(options.binary, args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(null, error);
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
      emitPartial();
    });

    function handleLine(line: string): void {
      if (!line.trim()) return;
      const event = parseAgyLine(line);
      if (!event) {
        text += `${line}\n`;
        return;
      }
      if (event.conversationId) conversationId = event.conversationId;
      if (event.kind === "delta" && typeof event.delta === "string") {
        text += event.delta;
        return;
      }
      if (event.kind === "result") {
        if (typeof event.response === "string" && event.response.trim()) text = event.response;
        status = event.status;
        durationSeconds = event.durationSeconds;
        usage = event.usage;
      }
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      emitPartial(true);
      finish(code);
    });

    options.onStatus?.(
      `agy ${summarizePrompt(options.prompt, STATUS_TAIL_CHARS)} (${options.mode}${options.model ? `, ${options.model}` : ""})`,
    );
  });
}

// ---------------------------------------------------------------------------
// result shaping
// ---------------------------------------------------------------------------

function renderOutcome(outcome: RunOutcome, context: { model?: string; cwd: string; mode: string }): string {
  if (outcome.authProblem) {
    return `${LOGIN_HINT}\n\nagy 输出：\n${truncate(outcome.stderr || outcome.text, 1000)}`;
  }
  if (outcome.aborted) {
    return `已取消。${outcome.text ? `\n\n部分输出：\n${truncate(outcome.text, 2000)}` : ""}`;
  }
  if (outcome.timedOut) {
    return `agy 超过超时时间被终止（${context.mode}）。${outcome.text ? `\n\n部分输出：\n${truncate(outcome.text, 4000)}` : ""}`;
  }
  if (!outcome.text) {
    const detail = truncate(outcome.stderr || "(agy 没有返回任何内容)", 2000);
    return `agy 退出码 ${outcome.exitCode ?? "unknown"}，没有文本输出。\n${detail}`;
  }

  const footer = formatRunFooter({
    conversationId: outcome.conversationId,
    durationSeconds: outcome.durationSeconds,
    usage: outcome.usage,
    status: outcome.status,
    model: context.model,
  });
  return footer ? `${truncate(outcome.text, MAX_OUTPUT_CHARS)}\n\n[${footer}]` : truncate(outcome.text, MAX_OUTPUT_CHARS);
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function agyBridge(pi: ExtensionAPI) {
  ensureStateDir();

  const background = new Map<string, () => void>();
  let modelCache: { id: string; label: string }[] | undefined;
  let modelCacheAt = 0;

  async function listModels(binary: string, force = false): Promise<{ id: string; label: string }[]> {
    if (!force && modelCache && Date.now() - modelCacheAt < 5 * 60_000) return modelCache;
    const models = await new Promise<{ id: string; label: string }[]>((resolve) => {
      let out = "";
      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawn(binary, ["models"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch {
        resolve([]);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child?.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve(parseModelList(out));
      }, 20_000);
      timer.unref?.();
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve([]);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(parseModelList(out));
      });
    });
    modelCache = models;
    modelCacheAt = Date.now();
    return models;
  }

  function probeVersion(binary: string): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      let out = "";
      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child?.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve(parseAgyVersion(out));
      }, 15_000);
      timer.unref?.();
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => (out += chunk));
      child.stderr?.on("data", (chunk: string) => (out += chunk));
      child.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(parseAgyVersion(out));
      });
    });
  }

  function resolveModel(spec?: string): { model?: string; effort?: string } {
    if (!spec || !spec.trim()) return {};
    const parsed = parseModelSpec(spec);
    return { model: parsed.model, effort: parsed.effort };
  }

  pi.registerTool({
    name: "ask_agy",
    label: "Ask Antigravity",
    description: `Delegate a self-contained task to Google Antigravity (the \`agy\` CLI — same family as Gemini CLI), so it works in parallel on this machine and reports back. Users may also call it "gemini", "antigravity" or "agy"; they all mean this tool.

agy runs its own agent loop: it can read, write, edit and run shell commands in the workspace, then returns its final answer. Use it for a second opinion from another model family, for heavy isolated work (research, refactors, reviews), or to keep a long side task out of this context.

Give it a COMPLETE, self-contained brief: agy does not see this conversation.

RESUMING: the result ends with a \`conversationId\`. Pass it back as \`conversationId\` to continue that same agy conversation with full context.

MODES (\`mode\`):
- \`accept-edits\` (default): agy may edit files and run commands in \`cwd\`.
- \`plan\`: review-shaped runs — agy proposes instead of applying. Not a security boundary; inline the material to review.
- \`auto\`: agy decides.

THINKING (\`thinking\` or its synonym \`effort\`): minimal|low|medium|high|xhigh|max, clamped to agy's low|medium|high.

BACKGROUND (\`background: true\`): returns immediately, agy keeps running, and its answer arrives later as a message. Do not poll.`,
    promptSnippet: "Hand a self-contained task to Google Antigravity (agy), which can edit files and run commands on its own",
    promptGuidelines: [
      "Use ask_agy when the user asks to ask gemini / ask antigravity / ask agy, or wants an independent second opinion or a long isolated side task.",
      "ask_agy cannot see this conversation: inline every fact, path and constraint the sub-task needs.",
      "If ask_agy returns a conversationId, pass it back when the task continues in the same thread.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete, self-contained task for agy. It has no access to this conversation." }),
      model: Type.Optional(
        Type.String({
          description:
            "agy model id or a bare tier, e.g. gemini-3.8-flash-medium, claude-sonnet-4-6, gpt-oss-120b-medium, or 'flash high'. Omit for the agy default.",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("plan"), Type.Literal("accept-edits"), Type.Literal("auto")], {
          description: "Execution mode. Default accept-edits.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({ description: "Thinking level: minimal|low|medium|high|xhigh|max (clamped to agy low|medium|high)." }),
      ),
      effort: Type.Optional(Type.String({ description: "Synonym for thinking. Pass only one of the two." })),
      conversationId: Type.Optional(
        Type.String({ description: "Continue a previous agy conversation by its id (see the previous result footer)." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Workspace directory for the run. Defaults to the session cwd." })),
      digest: Type.Optional(Type.Boolean({ description: "Ask agy for a compact digest instead of full file contents." })),
      timeoutMinutes: Type.Optional(
        Type.Number({ description: `Hard cap in minutes (default ${DEFAULT_TIMEOUT_MINUTES}, max ${MAX_TIMEOUT_MINUTES}).` }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "Run in the background; the answer arrives later as a message. Do not poll." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const binary = resolveBinary();
      if (!binary) {
        return {
          content: [{ type: "text", text: INSTALL_HINT }],
          details: { error: "agy-not-found" },
          isError: true,
        };
      }

      const spec = resolveModel(params.model);
      const effort = toAgyEffort(params.thinking ?? params.effort) ?? spec.effort;
      const mode = normalizeMode(params.mode);
      const cwd = defaultCwd(params.cwd);
      const timeoutMinutes = clampTimeoutMinutes(params.timeoutMinutes);

      const runOptions: RunOptions = {
        prompt: params.prompt,
        model: spec.model,
        effort,
        mode,
        cwd,
        conversationId: params.conversationId?.trim() || undefined,
        digest: params.digest === true,
        timeoutMinutes,
        binary,
        signal,
        onText: (partial) => {
          onUpdate?.({
            content: [{ type: "text", text: truncate(partial, 8000) }],
            details: { partial: true, cwd, mode, model: spec.model ?? "default" },
          });
        },
        onStatus: (line) => {
          onUpdate?.({
            content: [{ type: "text", text: `⏳ ${line}` }],
            details: { running: true, cwd, mode, model: spec.model ?? "default" },
          });
        },
      };

      if (params.background === true) {
        const runId = `agy-${Date.now().toString(36)}`;
        const done = runAgy(runOptions).then((outcome) => {
          background.delete(runId);
          const body = renderOutcome(outcome, { model: spec.model, cwd, mode });
          const header = outcome.conversationId ? `agy 后台任务 ${runId} 完成` : `agy 后台任务 ${runId} 结束`;
          try {
            pi.sendMessage(
              {
                customType: "agy-bridge",
                content: `${header}\n\n${body}`,
                display: true,
                details: { runId, conversationId: outcome.conversationId, status: outcome.status, cwd, mode },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          } catch {
            ctx.ui.notify(`agy 后台任务 ${runId} 完成（无法投递到会话）`, "warning");
          }
        });
        background.set(runId, () => {
          /* agy is killed by the timeout/abort path; nothing else to do here */
        });
        done.catch(() => background.delete(runId));

        return {
          content: [
            {
              type: "text",
              text: `agy 后台任务已启动（${runId}, mode=${mode}, model=${spec.model ?? "default"}, cwd=${cwd}）。结果到达时会以消息形式出现，不要轮询。`,
            },
          ],
          details: { runId, background: true, cwd, mode, model: spec.model ?? "default" },
        };
      }

      const outcome = await runAgy(runOptions);
      const text = renderOutcome(outcome, { model: spec.model, cwd, mode });
      const failed = Boolean(outcome.authProblem) || (!outcome.text && !outcome.timedOut && !outcome.aborted);

      return {
        content: [{ type: "text", text }],
        details: {
          conversationId: outcome.conversationId,
          status: outcome.status,
          durationSeconds: outcome.durationSeconds,
          usage: outcome.usage,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
          mode,
          cwd,
          model: spec.model ?? "default",
          effort: effort ?? "default",
        },
        isError: failed,
      };
    },
  });

  pi.registerCommand("agy", {
    description: "Antigravity 桥：(无参数) 状态 | models | ask <prompt> | doctor | help",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const [head, ...rest] = raw.split(/\s+/);
      const sub = (head ?? "").toLowerCase();
      const tail = rest.join(" ").trim();
      const binary = resolveBinary();

      if (sub === "help" || sub === "?") {
        ctx.ui.notify(
          [
            "/agy            状态总览（binary / 版本 / 模型数 / 配置）",
            "/agy models     列出 agy 可用模型",
            "/agy ask <文本>  直接把一句话交给 agy，结果贴回会话",
            "/agy doctor     体检：binary、版本、登录、会话目录",
            "工具：ask_agy（模型自己会调；plan / accept-edits / auto 三种模式）",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (!binary) {
        ctx.ui.notify(INSTALL_HINT, "error");
        return;
      }

      if (sub === "models") {
        const models = await listModels(binary, true);
        if (!models.length) {
          ctx.ui.notify("agy 没有返回模型列表，运行 /agy doctor 看细节。", "warning");
          return;
        }
        ctx.ui.notify(models.map((m) => `${m.id}  —  ${m.label}`).join("\n"), "info");
        return;
      }

      if (sub === "ask") {
        if (!tail) {
          ctx.ui.notify("用法：/agy ask <一句话任务>", "warning");
          return;
        }
        const outcome = await runAgy({
          prompt: tail,
          binary,
          mode: "accept-edits",
          cwd: process.cwd(),
          timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
          signal: undefined,
        });
        const body = renderOutcome(outcome, { cwd: process.cwd(), mode: "accept-edits" });
        try {
          pi.sendMessage(
            { customType: "agy-bridge", content: `agy /agy ask → ${summarizePrompt(tail)}\n\n${body}`, display: true },
            { deliverAs: "nextTurn" },
          );
        } catch {
          ctx.ui.notify(truncate(body, 1500), "info");
        }
        return;
      }

      if (sub === "doctor") {
        const lines = [`binary: ${binary}`];
        const version = await probeVersion(binary);
        lines.push(`version: ${version ?? "unknown"}`);

        const models = await listModels(binary, true);
        lines.push(`models: ${models.length ? `${models.length} 个` : "拉不到（可能未登录）"}`);
        lines.push(`login: ${models.length ? "ok" : "未知 — 运行 /agy models 或终端跑 agy 确认"}`);
        lines.push(`conversations: ${agyConversationsDir()}`);
        lines.push(`workspace: ${process.cwd()}`);
        lines.push(`AGY_BIN: ${process.env.AGY_BIN ?? "(未设置)"}`);
        lines.push(`cached models: ${modelCache?.length ?? 0}`);
        ctx.ui.notify(lines.join("\n"), models.length ? "info" : "warning");
        return;
      }

      // default: status
      const version = await probeVersion(binary);

      const lines = [
        "Antigravity 桥已就绪",
        `binary: ${binary}`,
        `version: ${version ?? "unknown"}`,
        `workspace: ${process.cwd()}`,
        `后台任务: ${background.size} 个在跑`,
        "",
        "工具：ask_agy   命令：/agy models | /agy ask <文本> | /agy doctor",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const binary = resolveBinary();
    if (!binary) {
      ctx.ui.notify(`agy 未找到，ask_agy 不可用。设置 AGY_BIN 或安装 Antigravity CLI。`, "warning");
    }
  });
}
