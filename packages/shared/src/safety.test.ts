import { describe, it, expect } from "vitest";
import { isSensitivePath, isProtectedBranch, SafetyMiddleware, type DaybreakConfig } from "./index.js";

const config: DaybreakConfig = {
  llm: { provider: "custom", baseUrl: "http://localhost", apiKey: "x", modelId: "test" },
  llmPricing: {},
  maxTurns: 40,
  maxWallClockMinutes: 20,
  maxCostUsd: 0.5,
  protectedBranches: ["main", "master"],
  denylistPatterns: [".env", ".env.*", "*.pem", ".ssh/**", "**/*secret*"],
  requireApprovalForDestructive: true,
  compactionEnabled: true,
  compactionReserveTokens: 4000,
  compactionKeepRecentTokens: 8000,
  ciSelfHealEnabled: true,
  prBranchPrefix: "daybreak/",
  maxHealAttemptsPerPr: 2,
  maxCiLogBytes: 524288,
  ciLogContextLines: 20,
  healCooldownSeconds: 60,
  maxConcurrentTasks: 2,
  queueWorkerPollMs: 1000,
  queueWorkerEnabled: true,
};

describe("isSensitivePath", () => {
  it("blocks .env files", () => {
    expect(isSensitivePath(".env", config.denylistPatterns)).toBe(true);
    expect(isSensitivePath("packages/app/.env", config.denylistPatterns)).toBe(true);
    expect(isSensitivePath("packages/app/.env.local", config.denylistPatterns)).toBe(true);
  });

  it("blocks pem and ssh keys", () => {
    expect(isSensitivePath("id.pem", config.denylistPatterns)).toBe(true);
    expect(isSensitivePath(".ssh/id_rsa", config.denylistPatterns)).toBe(true);
  });

  it("blocks paths containing secret", () => {
    expect(isSensitivePath("src/secrets.json", config.denylistPatterns)).toBe(true);
  });

  it("allows normal source files", () => {
    expect(isSensitivePath("src/index.ts", config.denylistPatterns)).toBe(false);
  });
});

describe("isProtectedBranch", () => {
  it("protects main and master", () => {
    expect(isProtectedBranch("main", config.protectedBranches)).toBe(true);
    expect(isProtectedBranch("master", config.protectedBranches)).toBe(true);
    expect(isProtectedBranch("feature/x", config.protectedBranches)).toBe(false);
  });
});

describe("SafetyMiddleware", () => {
  it("blocks reading .env", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("read", { path: ".env" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sensitive-file denylist");
  });

  it("blocks reading .env via bash", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "cat /home/user/target/.env" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denylist");
  });

  it("blocks commit messages mentioning .env", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "git commit -m 'update .env'" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denylist");
  });

  it("does not block commit messages with generic words", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "git commit -m 'fix password validation'" });
    expect(result.allowed).toBe(true);
  });

  it("blocks destructive bash", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "rm -rf /" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Destructive command");
  });

  it("blocks git push to protected branch", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "git push origin main" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("protected branch");
  });

  it("requires approval for git push", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "git push origin feature/x" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("requires explicit approval");
  });

  it("approves safe bash", () => {
    const safety = new SafetyMiddleware(config);
    const result = safety.beforeToolCall("bash", { command: "npm test" });
    expect(result.allowed).toBe(true);
  });

  it("auto-approve bypasses approval gate", () => {
    const safety = new SafetyMiddleware(config);
    safety.approveAll();
    const result = safety.beforeToolCall("bash", { command: "git push origin feature/x" });
    expect(result.allowed).toBe(true);
  });
});
