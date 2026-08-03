import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafetyMiddleware, loadConfig } from "@daybreak/shared";
import { TaskRunner } from "./session.js";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

vi.mock("./llm.js", () => ({
  createModelRuntime: vi.fn().mockResolvedValue({
    modelRuntime: {},
    model: {
      id: "test",
      name: "test",
      api: "openai-completions",
      provider: "primary",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    },
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(),
  };
});

async function importCreateAgentSession() {
  const mod = await import("@earendil-works/pi-coding-agent");
  return mod.createAgentSession as ReturnType<typeof vi.fn>;
}

function buildFakeSession(events: AgentSessionEvent[]): AgentSession {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session = {
    agent: {
      state: { systemPrompt: "", messages: [] },
      beforeToolCall: undefined,
    },
    sessionManager: undefined,
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async () => {
      for (const event of events) {
        listeners.forEach((listener) => listener(event));
      }
    },
    dispose: vi.fn(),
    abort: vi.fn(),
  } as unknown as AgentSession;
  return session;
}

function buildRunnerConfig(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const base = loadConfig();
  return {
    ...base,
    maxTurns: 3,
    maxWallClockMinutes: 60,
    maxCostUsd: 100,
    checkpointInterval: "tool" as const,
    ...overrides,
  };
}

describe("SafetyMiddleware file limits", () => {
  it("blocks read when file size exceeds DAYBREAK_MAX_FILE_READ_BYTES", () => {
    const dir = mkdtempSync(join(tmpdir(), "daybreak-limits-"));
    const file = join(dir, "huge.txt");
    writeFileSync(file, "hello world!"); // 12 bytes

    const config = buildRunnerConfig({ maxFileReadBytes: 10, maxFileReadLines: 10_000 });
    const safety = new SafetyMiddleware(config);
    safety.setCwd(dir);

    const result = safety.beforeToolCall("read", { path: file });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("file_too_large");
    expect(result.reason).toContain("File too large");

    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks read when line count exceeds DAYBREAK_MAX_FILE_READ_LINES", () => {
    const dir = mkdtempSync(join(tmpdir(), "daybreak-limits-"));
    const file = join(dir, "multiline.txt");
    writeFileSync(file, "line1\nline2\nline3\n"); // 3 lines

    const config = buildRunnerConfig({ maxFileReadBytes: 1_000_000, maxFileReadLines: 2 });
    const safety = new SafetyMiddleware(config);
    safety.setCwd(dir);

    const result = safety.beforeToolCall("read", { path: file });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("file_too_large");
    expect(result.reason).toContain("too many lines");

    rmSync(dir, { recursive: true, force: true });
  });

  it("allows read when file is within limits", () => {
    const dir = mkdtempSync(join(tmpdir(), "daybreak-limits-"));
    const file = join(dir, "small.txt");
    writeFileSync(file, "ok");

    const config = buildRunnerConfig({ maxFileReadBytes: 100, maxFileReadLines: 100 });
    const safety = new SafetyMiddleware(config);
    safety.setCwd(dir);

    const result = safety.beforeToolCall("read", { path: file });
    expect(result.allowed).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("TaskRunner circuit breaker", () => {
  it("emits circuit_breaker_triggered when maxTurns is reached", async () => {
    const createAgentSession = await importCreateAgentSession();
    const events: AgentSessionEvent[] = [
      { type: "turn_start" },
      { type: "turn_start" },
      { type: "turn_start" },
      { type: "turn_start" },
      { type: "agent_end", willRetry: false },
    ] as AgentSessionEvent[];
    createAgentSession.mockResolvedValueOnce({ session: buildFakeSession(events) });

    const dir = mkdtempSync(join(tmpdir(), "daybreak-circuit-"));
    const runner = new TaskRunner(buildRunnerConfig());
    const captured: { type: string }[] = [];

    const result = await runner.run({
      prompt: "keep going",
      cwd: dir,
      onEvent: (event) => captured.push({ type: event.type }),
    });

    const breaker = captured.find((e) => e.type === "circuit_breaker_triggered");
    expect(breaker).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Max turns");

    rmSync(dir, { recursive: true, force: true });
  });
});
