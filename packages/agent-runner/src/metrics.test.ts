import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, it, expect } from "vitest";
import { MetricsCollector } from "./metrics.js";

function assistantMessage(provider = "custom", model = "gpt-4o-mini", input = 1000, output = 500): AgentMessage {
  return {
    role: "assistant",
    provider,
    model,
    api: "openai-completions",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("MetricsCollector", () => {
  it("tracks tool calls and turns", () => {
    const metrics = new MetricsCollector();
    metrics.recordTurn();
    metrics.startToolCall({ id: "1", toolName: "read", args: { path: "x" }, startedAt: Date.now() });
    metrics.endToolCall("1");
    const result = metrics.finalize();
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks blocked tool calls", () => {
    const metrics = new MetricsCollector();
    metrics.startToolCall({ id: "1", toolName: "read", args: { path: ".env" }, startedAt: Date.now() });
    metrics.blockToolCall("1", "denylist");
    const result = metrics.finalize();
    expect(result.blockedToolCalls).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it("computes cost from the pricing map", () => {
    const metrics = new MetricsCollector({ "custom/gpt-4o-mini": { input: 0.15, output: 0.6 } });
    const message = assistantMessage();
    metrics.recordMessage(message);
    expect(metrics.current().estimatedCostUsd).toBeCloseTo(0.00045);
  });

  it("falls back to modelId and wildcard pricing keys", () => {
    const metrics = new MetricsCollector({
      "gpt-4o-mini": { input: 1, output: 2 },
      "*": { input: 5, output: 10 },
    });
    metrics.recordMessage(assistantMessage("custom", "gpt-4o-mini", 1000, 500));
    expect(metrics.current().estimatedCostUsd).toBeCloseTo(0.002);
  });
});
