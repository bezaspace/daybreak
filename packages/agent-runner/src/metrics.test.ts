import { describe, it, expect } from "vitest";
import { MetricsCollector } from "./metrics.js";

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
});
