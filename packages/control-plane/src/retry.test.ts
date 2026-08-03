import { describe, it, expect } from "vitest";
import { RetryClassifier, RetryScheduler } from "./retry.js";

describe("RetryClassifier", () => {
  it("retries E2B sandbox errors", () => {
    expect(RetryClassifier.isRetryable(new Error("E2B sandbox creation failed"))).toBe(true);
  });

  it("retries network timeout errors", () => {
    expect(RetryClassifier.isRetryable(new Error("connect ETIMEDOUT"))).toBe(true);
  });

  it("retries 429 rate limit errors", () => {
    expect(RetryClassifier.isRetryable(new Error("LLM provider returned 429"))).toBe(true);
  });

  it("does not retry safety blocks", () => {
    expect(RetryClassifier.isRetryable(new Error("Safety block: read .env is not allowed"))).toBe(false);
  });

  it("does not retry branch protection blocks", () => {
    expect(RetryClassifier.isRetryable(new Error("push to protected branch main blocked"))).toBe(false);
  });

  it("does not retry max turns exhaustion", () => {
    expect(RetryClassifier.isRetryable(new Error("max turns reached"))).toBe(false);
  });
});

describe("RetryScheduler", () => {
  it("schedules increasing backoff delays", () => {
    const now = Date.now();
    const first = RetryScheduler.nextRetryAt(1);
    const second = RetryScheduler.nextRetryAt(2);
    const third = RetryScheduler.nextRetryAt(3);

    expect(first).toBeGreaterThanOrEqual(now + 30_000 - 100);
    expect(second).toBeGreaterThanOrEqual(now + 120_000 - 100);
    expect(third).toBeGreaterThanOrEqual(now + 300_000 - 100);

    expect(second - now).toBeGreaterThan(first - now);
    expect(third - now).toBeGreaterThan(second - now);
  });
});
