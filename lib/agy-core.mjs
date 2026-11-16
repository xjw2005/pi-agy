/**
 * agy-core — pure, side-effect-free helpers for the Pi <-> Antigravity bridge.
 *
 * Everything here is testable with `node --test` alone: no Pi runtime, no
 * network, no `agy` binary, no child processes. The extension layer
 * (extensions/agy-bridge.ts) does the I/O and calls into this module.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 60 * 12;
export const DEFAULT_MODE = "accept-edits";
export const MODES = ["plan", "accept-edits", "auto"];

/** Pi thinking vocabulary -> agy effort tiers (agy only knows low|medium|high). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_MAP = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const MODEL_TIER_WORDS = Object.keys(EFFORT_MAP).join("|");

/**
 * Clamp a pi thinking level to an agy effort tier.
 * Unknown values fall back to `undefined` (let agy decide).
 */
export function toAgyEffort(value) {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EFFORT_MAP, key) ? EFFORT_MAP[key] : undefined;
}

/** Normalize an execution mode; unknown values fall back to `accept-edits`. */
export function normalizeMode(value, fallback = DEFAULT_MODE) {
  if (typeof value !== "string") return fallback;
  const mode = value.trim().toLowerCase();
  return MODES.includes(mode) ? mode : fallback;
}

/**
 * Split a model spec into `{ model, effort }`.
 * Accepts `"flash high"`, `"antigravity/gemini-3.8-flash-high"`, `"gemini-3.8-flash-medium"`.
 * A trailing tier is only peeled off when whitespace separated, so real model
 * ids that end in `-high` / `-low` survive untouched.
 */
export function parseModelSpec(spec) {
  if (typeof spec !== "string" || !spec.trim()) return {};
  let text = spec.trim();
  if (text.toLowerCase().startsWith("antigravity/")) text = text.slice("antigravity/".length);

  let effort;
  const tiered = new RegExp(`^(.+?)\\s+(${MODEL_TIER_WORDS})$`, "i").exec(text);
  if (tiered) {
    text = tiered[1].trim();
    effort = toAgyEffort(tiered[2]);
  }

  const spec2 = {};
  if (text) spec2.model = text;
  if (effort) spec2.effort = effort;
  return spec2;
}

/** Clamp a timeout in minutes to a sane range (0 is not allowed). */
export function clampTimeoutMinutes(value, { fallback = DEFAULT_TIMEOUT_MINUTES, max = MAX_TIMEOUT_MINUTES } = {}) {
  const minutes = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return Math.min(minutes, max);
}

/** Prefix a prompt so agy answers with short digests instead of full files. */
export function applyDigest(prompt, digest) {
  if (!digest) return prompt;
  return `[COMPACT OUTPUT] Answer with a compact digest: bullets and short excerpts only, never paste whole files.\n\n${prompt}`;
}

/**
 * Build the `agy` argv for one delegation run.
 * The process cwd is set by the caller, so no --add-dir is emitted.
 */
export function buildAgyArgs(options = {}) {
  const {
    prompt,
    model,
    effort,
    mode,
    conversationId,
    outputFormat = "stream-json",
    printTimeoutSeconds = 0,
  } = options;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TypeError("buildAgyArgs: prompt is required");
  }

  const args = ["-p", prompt];

  if (outputFormat) args.push("--output-format", outputFormat);
  if (mode) args.push("--mode", mode);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (conversationId) args.push("--conversation", conversationId);
  if (printTimeoutSeconds > 0) args.push("--print-timeout", `${Math.round(printTimeoutSeconds)}s`);

  return args;
}

/**
 * Parse one line of `agy --output-format stream-json` into a normalized event.
 * Returns null for blank/unparsable lines so callers can treat them as plain text.
 */
export function parseAgyLine(line) {
  const text = typeof line === "string" ? line.trim() : "";
  if (!text || text[0] !== "{") return null;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const conversationId = payload.conversation_id ?? payload.conversationId ?? undefined;

  if (payload.event === "init") {
    return { kind: "init", conversationId, cwd: payload.init?.cwd, permissionMode: payload.init?.permission_mode };
  }

  if (payload.event === "step_update") {
    const step = payload.step_update ?? {};
    const delta = typeof step.text_delta === "string" ? step.text_delta : undefined;
    return {
      kind: delta ? "delta" : "step",
      conversationId: step.conversation_id ?? conversationId,
      delta,
      state: step.state,
      stepType: step.step_type,
      usage: step.usage,
    };
  }

  if (payload.event === "result") {
    const result = payload.result ?? {};
    return {
      kind: "result",
      conversationId: result.conversation_id ?? conversationId,
      status: result.status,
      response: typeof result.response === "string" ? result.response : undefined,
      durationSeconds: result.duration_seconds,
      usage: result.usage,
      numTurns: result.num_turns,
    };
  }

  if (payload.event) return { kind: "other", conversationId, event: payload.event };
  return { kind: "other", conversationId };
}

/** Parse `agy models` stdout into `[{ id, label }]`. */
export function parseModelList(stdout) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Fetching")) continue;
    const [idPart, ...labelParts] = line.split("\t");
    const id = idPart.trim();
    if (!id || !/^[A-Za-z0-9][\w.:/-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: labelParts.join(" ").trim() || id });
  }
  return models;
}

/** First `agy <version>` / `agy version <version>` match, else undefined. */
export function parseAgyVersion(stdout) {
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(String(stdout ?? ""));
  return match ? match[1] : undefined;
}

/** Human summary of an agy usage block. */
export function formatUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const parts = [];
  if (Number.isFinite(usage.input_tokens)) parts.push(`in ${usage.input_tokens}`);
  if (Number.isFinite(usage.output_tokens)) parts.push(`out ${usage.output_tokens}`);
  if (Number.isFinite(usage.thinking_tokens) && usage.thinking_tokens > 0) parts.push(`think ${usage.thinking_tokens}`);
  if (Number.isFinite(usage.cache_read_tokens) && usage.cache_read_tokens > 0) parts.push(`cache ${usage.cache_read_tokens}`);
  return parts.length ? parts.join(" / ") : undefined;
}

/** Short, stable duration label: `3.0s`, `1m12s`, `2h3m`. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * One-line status footer appended to a delegation result so the caller can
 * resume the same agy conversation or judge the run.
 */
export function formatRunFooter({ conversationId, durationSeconds, usage, status, model } = {}) {
  const bits = [];
  if (status) bits.push(`status ${status}`);
  if (model) bits.push(`model ${model}`);
  const duration = formatDuration(durationSeconds);
  if (duration) bits.push(`took ${duration}`);
  const usageText = formatUsage(usage);
  if (usageText) bits.push(usageText);

  const lines = [];
  if (bits.length) lines.push(bits.join(" | "));
  if (conversationId) {
    lines.push(`conversationId: ${conversationId} (pass it back to continue this agy conversation)`);
  }
  return lines.join("\n");
}

/** True when agy output looks like a login/credential problem. */
export function detectAuthFailure(text) {
  if (typeof text !== "string" || !text) return false;
  return /not logged in|unauthenticated|login required|please (?:log|sign) ?in|invalid_grant|401 unauthori[sz]ed|no credentials/i.test(
    text,
  );
}

/** Resolve the `agy` executable without spawning anything. */
export function findAgyBinary({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  exists = existsSync,
} = {}) {
  const names = platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat", "agy"] : ["agy"];
  const candidates = [];

  if (env.AGY_BIN && String(env.AGY_BIN).trim()) candidates.push(String(env.AGY_BIN).trim());

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const pathValue = env[pathKey] ?? "";
  for (const dir of String(pathValue).split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(path.join(dir, name));
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local");
    candidates.push(path.join(localAppData, "agy", "bin", "agy.exe"));
    candidates.push(path.join(localAppData, "Programs", "agy", "agy.exe"));
    candidates.push(path.join(homedir, ".local", "bin", "agy.exe"));
  } else {
    candidates.push(path.join(homedir, ".local", "bin", "agy"));
    candidates.push("/usr/local/bin/agy");
    candidates.push("/opt/homebrew/bin/agy");
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* unreadable candidate: keep looking */
    }
  }
  return undefined;
}

/** Where agy keeps conversations; used only for diagnostics. */
export function agyConversationsDir({ env = process.env, homedir = os.homedir() } = {}) {
  const home = env.AGY_HOME && String(env.AGY_HOME).trim() ? String(env.AGY_HOME).trim() : path.join(homedir, ".gemini");
  return path.join(home, "antigravity-cli");
}

/** Keep a prompt tail short enough for a TUI status line. */
export function summarizePrompt(prompt, maxChars = 80) {
  const flat = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Truncate long text with an explicit marker. */
export function truncate(text, maxChars = 1200) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

/** Instructions shown when the binary is missing or the user is not logged in. */
export const INSTALL_HINT =
  "agy 未安装。安装：curl -fsSL https://antigravity.google/cli/install.sh | bash（Windows 用 install.ps1），或用 AGY_BIN 指向已有可执行文件。";
export const LOGIN_HINT = "agy 未登录。先在终端运行 `agy` 完成 Google 授权，然后 /exit。";
