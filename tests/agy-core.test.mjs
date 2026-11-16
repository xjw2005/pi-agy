import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  applyDigest,
  buildAgyArgs,
  clampTimeoutMinutes,
  detectAuthFailure,
  findAgyBinary,
  formatDuration,
  formatRunFooter,
  formatUsage,
  normalizeMode,
  parseAgyLine,
  parseAgyVersion,
  parseModelList,
  parseModelSpec,
  summarizePrompt,
  toAgyEffort,
  truncate,
} from "../lib/agy-core.mjs";

test("toAgyEffort clamps pi thinking levels onto agy effort tiers", () => {
  assert.equal(toAgyEffort("minimal"), "low");
  assert.equal(toAgyEffort("low"), "low");
  assert.equal(toAgyEffort("medium"), "medium");
  assert.equal(toAgyEffort("HIGH"), "high");
  assert.equal(toAgyEffort("xhigh"), "high");
  assert.equal(toAgyEffort("max"), "high");
  assert.equal(toAgyEffort("nonsense"), undefined);
  assert.equal(toAgyEffort(undefined), undefined);
});

test("normalizeMode accepts known modes and falls back for junk", () => {
  assert.equal(normalizeMode("plan"), "plan");
  assert.equal(normalizeMode("ACCEPT-EDITS"), "accept-edits");
  assert.equal(normalizeMode("auto"), "auto");
  assert.equal(normalizeMode("yolo"), "accept-edits");
  assert.equal(normalizeMode(undefined), "accept-edits");
  assert.equal(normalizeMode(undefined, "plan"), "plan");
});

test("parseModelSpec splits an explicit tier but keeps real model ids intact", () => {
  assert.deepEqual(parseModelSpec("gemini-3.8-flash-high"), { model: "gemini-3.8-flash-high" });
  assert.deepEqual(parseModelSpec("flash high"), { model: "flash", effort: "high" });
  assert.deepEqual(parseModelSpec("antigravity/claude-sonnet-4-6"), { model: "claude-sonnet-4-6" });
  assert.deepEqual(parseModelSpec("  claude-opus-4-6-thinking  "), { model: "claude-opus-4-6-thinking" });
  assert.deepEqual(parseModelSpec("claude-sonnet-4-6 max"), { model: "claude-sonnet-4-6", effort: "high" });
  assert.deepEqual(parseModelSpec(""), {});
  assert.deepEqual(parseModelSpec(undefined), {});
});

test("clampTimeoutMinutes never returns zero or an absurd cap", () => {
  assert.equal(clampTimeoutMinutes(undefined), DEFAULT_TIMEOUT_MINUTES);
  assert.equal(clampTimeoutMinutes(0), DEFAULT_TIMEOUT_MINUTES);
  assert.equal(clampTimeoutMinutes(-3), DEFAULT_TIMEOUT_MINUTES);
  assert.equal(clampTimeoutMinutes("12"), 12);
  assert.equal(clampTimeoutMinutes(9999), MAX_TIMEOUT_MINUTES);
});

test("buildAgyArgs emits one-shot argv in a stable order", () => {
  assert.deepEqual(buildAgyArgs({ prompt: "hi" }), ["-p", "hi", "--output-format", "stream-json"]);
  assert.deepEqual(
    buildAgyArgs({
      prompt: "review this",
      mode: "plan",
      model: "gemini-3.8-flash-medium",
      effort: "high",
      conversationId: "4bb2873b-af7e-4925-a4c9-54bfb9240c24",
      printTimeoutSeconds: 60,
    }),
    [
      "-p",
      "review this",
      "--output-format",
      "stream-json",
      "--mode",
      "plan",
      "--model",
      "gemini-3.8-flash-medium",
      "--effort",
      "high",
      "--conversation",
      "4bb2873b-af7e-4925-a4c9-54bfb9240c24",
      "--print-timeout",
      "60s",
    ],
  );
  assert.throws(() => buildAgyArgs({}), TypeError);
  assert.throws(() => buildAgyArgs({ prompt: "   " }), TypeError);
});

test("buildAgyArgs never passes the skip-permissions flag", () => {
  const args = buildAgyArgs({ prompt: "x", mode: "auto" });
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("applyDigest prefixes only when asked", () => {
  assert.equal(applyDigest("answer", false), "answer");
  const prefixed = applyDigest("answer", true);
  assert.match(prefixed, /^\[COMPACT OUTPUT\]/);
  assert.match(prefixed, /answer$/);
});

test("parseAgyLine normalizes init / delta / result events", () => {
  assert.deepEqual(
    parseAgyLine(
      '{"event":"init","conversation_id":"abc","init":{"cwd":"C:\\\\w","permission_mode":"request-review"}}',
    ),
    { kind: "init", conversationId: "abc", cwd: "C:\\w", permissionMode: "request-review" },
  );

  const delta = parseAgyLine(
    '{"event":"step_update","step_update":{"conversation_id":"abc","state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
  );
  assert.equal(delta.kind, "delta");
  assert.equal(delta.delta, "OK");
  assert.equal(delta.conversationId, "abc");

  const result = parseAgyLine(
    '{"event":"result","result":{"conversation_id":"abc","status":"SUCCESS","response":"OK\\n","duration_seconds":2.5,"usage":{"input_tokens":10,"output_tokens":2}}}',
  );
  assert.equal(result.kind, "result");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "OK\n");
  assert.equal(result.durationSeconds, 2.5);
  assert.equal(result.usage.output_tokens, 2);

  assert.equal(parseAgyLine("plain text"), null);
  assert.equal(parseAgyLine("{broken json"), null);
  assert.equal(parseAgyLine(""), null);
});

test("parseModelList reads the tab separated catalogue", () => {
  const stdout = [
    "Fetching available models...",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    "claude-sonnet-4-6\tduplicate",
    "",
  ].join("\n");
  const models = parseModelList(stdout);
  assert.deepEqual(models, [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  ]);
  assert.deepEqual(parseModelList(""), []);
});

test("parseAgyVersion extracts a semver", () => {
  assert.equal(parseAgyVersion("1.5.9"), "1.5.9");
  assert.equal(parseAgyVersion("agy version 1.5.9\n"), "1.5.9");
  assert.equal(parseAgyVersion("no version here"), undefined);
});

test("formatUsage and formatDuration stay readable", () => {
  assert.equal(formatUsage({ input_tokens: 9785, output_tokens: 33, thinking_tokens: 31 }), "in 9785 / out 33 / think 31");
  assert.equal(formatUsage({}), undefined);
  assert.equal(formatUsage(undefined), undefined);
  assert.equal(formatDuration(3.05), "3.0s");
  assert.equal(formatDuration(72), "1m12s");
  assert.equal(formatDuration(3720), "1h02m");
  assert.equal(formatDuration(undefined), undefined);
});

test("formatRunFooter carries the resume handle", () => {
  const footer = formatRunFooter({
    conversationId: "abc-123",
    durationSeconds: 12,
    status: "SUCCESS",
    model: "gemini-3.8-flash-medium",
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  assert.match(footer, /status SUCCESS/);
  assert.match(footer, /model gemini-3\.8-flash-medium/);
  assert.match(footer, /took 12\.0s/);
  assert.match(footer, /conversationId: abc-123/);
  assert.equal(formatRunFooter({}), "");
});

test("detectAuthFailure spots login problems", () => {
  assert.equal(detectAuthFailure("Error: not logged in"), true);
  assert.equal(detectAuthFailure("401 Unauthorized"), true);
  assert.equal(detectAuthFailure("please log in first"), true);
  assert.equal(detectAuthFailure("Execution finished normally"), false);
  assert.equal(detectAuthFailure(""), false);
});

test("findAgyBinary prefers AGY_BIN, then PATH, then platform defaults", () => {
  const existing = new Set(["/opt/custom/agy", "/usr/local/bin/agy"]);

  const viaEnv = findAgyBinary({
    env: { AGY_BIN: "/opt/custom/agy", PATH: "" },
    platform: "linux",
    homedir: "/home/u",
    exists: (p) => existing.has(p),
  });
  assert.equal(viaEnv, "/opt/custom/agy");

  const viaPath = findAgyBinary({
    env: { PATH: ["/nope", "/usr/local/bin"].join(":") },
    platform: "linux",
    homedir: "/home/u",
    exists: (p) => existing.has(p),
  });
  assert.equal(viaPath, "/usr/local/bin/agy");

  const viaDefault = findAgyBinary({
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PATH: "" },
    platform: "win32",
    homedir: "C:\\Users\\u",
    exists: (p) => p === "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe",
  });
  assert.equal(viaDefault, "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe");

  const missing = findAgyBinary({
    env: { PATH: "" },
    platform: "linux",
    homedir: "/home/u",
    exists: () => false,
  });
  assert.equal(missing, undefined);
});

test("findAgyBinary survives a broken exists() probe", () => {
  const found = findAgyBinary({
    env: { PATH: "/only" },
    platform: "linux",
    homedir: "/home/u",
    exists: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(found, undefined);
});

test("summarizePrompt and truncate bound their output", () => {
  assert.equal(summarizePrompt("  a \n b  "), "a b");
  assert.equal(summarizePrompt("x".repeat(200)).length, 80);
  assert.equal(truncate("short"), "short");
  assert.match(truncate("y".repeat(50), 10), /truncated 40 chars/);
});
