import type { Task } from "./db.js";

export interface RetryContext {
  triggerSource?: string;
  task?: Task;
}

export class RetryClassifier {
  static isRetryable(error: unknown, _triggerSource?: string, _context?: RetryContext): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    const retryablePatterns = [
      "e2b",
      "sandbox",
      "timeout",
      "timed out",
      "etimedout",
      "etimeout",
      "econnrefused",
      "econnreset",
      "enetunreach",
      "ENOTFOUND",
      "fetch failed",
      "network",
      "5",
      "429",
      "too many requests",
      "rate limit",
      "upstash",
      "supabase",
      "bundle upload",
      "git clone",
      "git fetch",
      "git pull",
      "git push",
    ];

    const nonRetryablePatterns = [
      "safety",
      "branch protection",
      "protected branch",
      "max turns",
      "max cost",
      "max wall clock",
      "budget",
      "quota",
      "invalid repo",
      "not found",
      "404",
      "401",
      "403",
      "unauthorized",
      "auth",
      "test failure",
      "tests failed",
      "heal attempts",
      "max heal",
      "blocked",
    ];

    if (nonRetryablePatterns.some((p) => lower.includes(p))) return false;
    return retryablePatterns.some((p) => lower.includes(p));
  }
}

export class RetryScheduler {
  static nextRetryAt(retryCount: number): number {
    const base = 30_000; // 30s
    const multipliers = [1, 4, 10, 20]; // 30s, 2m, 5m, 10m
    const multiplier = multipliers[Math.min(retryCount, multipliers.length - 1)];
    return Date.now() + base * multiplier;
  }
}
