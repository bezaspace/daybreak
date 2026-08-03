import { describe, it, expect, vi } from "vitest";
import { redactSecrets } from "@daybreak/shared";
import { CiLogFetcher, CiLogParser, cleanLogLine, isFailureLine } from "./ci-logs.js";

describe("CiLogFetcher", () => {
  it("fetches and filters failure annotations", async () => {
    const mockFetch = vi.fn(async () =>
      Response.json([
        { path: "src/index.ts", start_line: 42, annotation_level: "failure", message: "type mismatch", title: "TS error" },
        { path: "src/index.ts", start_line: 10, annotation_level: "warning", message: "unused variable", title: "lint" },
        { path: "tests/index.test.ts", start_line: 5, annotation_level: "failure", message: "assertion failed", title: "test" },
      ]),
    );

    const fetcher = new CiLogFetcher("test-token", { fetch: mockFetch as typeof fetch });
    const annotations = await fetcher.fetchAnnotations("bezaspace", "daybreak-target", 12345);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/bezaspace/daybreak-target/check-runs/12345/annotations",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );

    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toEqual({ path: "src/index.ts", start_line: 42, message: "type mismatch", title: "TS error" });
    expect(annotations[1]).toEqual({ path: "tests/index.test.ts", start_line: 5, message: "assertion failed", title: "test" });
  });

  it("throws when GitHub annotations request fails", async () => {
    const mockFetch = vi.fn(async () => new Response("Not found", { status: 404, statusText: "Not Found" }));
    const fetcher = new CiLogFetcher("test-token", { fetch: mockFetch as typeof fetch });
    await expect(fetcher.fetchAnnotations("owner", "repo", 1)).rejects.toThrow("GitHub annotations request failed: 404 Not Found");
  });

  it("downloads job logs and returns the full text when under maxBytes", async () => {
    const mockFetch = vi.fn(async () => new Response("log line 1\nlog line 2\n"));
    const fetcher = new CiLogFetcher("test-token", { fetch: mockFetch as typeof fetch });
    const logs = await fetcher.fetchJobLogs("owner", "repo", 123);

    expect(logs).toBe("log line 1\nlog line 2\n");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/jobs/123/logs",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("truncates job logs from the end to maxBytes starting at a line boundary", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i.toString().padStart(3, "0")}`);
    }
    const log = lines.join("\n") + "\n";
    const maxBytes = 300;

    const mockFetch = vi.fn(async () => new Response(log));
    const fetcher = new CiLogFetcher("test-token", { fetch: mockFetch as typeof fetch });
    const tail = await fetcher.fetchJobLogs("owner", "repo", 1, maxBytes);

    expect(tail.length).toBeLessThanOrEqual(maxBytes);
    expect(tail).toContain("line 099");
    expect(tail.startsWith("line ")).toBe(true);
    expect(tail.includes("line 000")).toBe(false);
  });

  it("throws when GitHub job logs request fails", async () => {
    const mockFetch = vi.fn(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }));
    const fetcher = new CiLogFetcher("test-token", { fetch: mockFetch as typeof fetch });
    await expect(fetcher.fetchJobLogs("owner", "repo", 1)).rejects.toThrow("GitHub job logs request failed: 403 Forbidden");
  });
});

describe("CiLogParser", () => {
  it("extracts the failing test and error block from a mocked 100 KB log", () => {
    const { log, failureBlock } = buildLargeLog();
    expect(log.length).toBeGreaterThanOrEqual(100_000);

    const parser = new CiLogParser({ contextLines: 5, maxFailureBlocks: 3 });
    const context = parser.parseErrorContext(log);

    expect(context).toContain("FAIL  src/ci-logs.test.ts > parse");
    expect(context).toContain("AssertionError: expected true to be false");
    expect(context).toContain("Tests: 1 failed, 0 passed");
    expect(context).toContain("npm ERR! Test failed");
    expect(context).not.toContain("irrelevant passing line 0");
    expect(context.length).toBeLessThan(log.length / 2);
  });

  it("includes annotations and check output text in the context", () => {
    const annotations = [{ path: "src/index.ts", start_line: 42, message: "type mismatch", title: "TS error" }];
    const output = { title: "Build failed", summary: "1 test failed", text: "See the log for details." };
    const log = [
      "2024-01-15T10:00:00.0000000Z ##[group]Run npm test",
      "2024-01-15T10:00:00.0000000Z npm test",
      "2024-01-15T10:00:01.0000000Z FAIL src/index.test.ts",
      "2024-01-15T10:00:01.5000000Z Error: expected 1 to be 2",
      "2024-01-15T10:00:02.0000000Z ##[endgroup]",
    ].join("\n");

    const parser = new CiLogParser({ contextLines: 2 });
    const context = parser.parseErrorContext(log, annotations, output);

    expect(context).toContain("Check output:");
    expect(context).toContain("Build failed");
    expect(context).toContain("1 test failed");
    expect(context).toContain("See the log for details.");
    expect(context).toContain("src/index.ts:42");
    expect(context).toContain("FAIL src/index.test.ts");
  });
});

describe("redactSecrets", () => {
  it("removes a synthetic API_KEY without mangling the surrounding text", () => {
    const text =
      "The API_KEY=abc123def456 is set in the environment. The token: shhh-secret-value is exposed. " +
      "Call https://user:passw0rd@example.com/api?token=xyz789&api_key=qwerty " +
      "with Authorization: Bearer supersecrettoken. Keep the surrounding text intact.";

    const result = redactSecrets(text);

    expect(result).toContain("The API_KEY=*** is set");
    expect(result).toContain("The token: *** is exposed");
    expect(result).toContain("https://***:***@example.com/api?token=***&api_key=***");
    expect(result).toContain("Authorization: Bearer ***");
    expect(result).toContain("Keep the surrounding text intact");
    expect(result).not.toContain("abc123def456");
    expect(result).not.toContain("shhh-secret-value");
    expect(result).not.toContain("passw0rd");
    expect(result).not.toContain("supersecrettoken");
    expect(result).not.toContain("xyz789");
    expect(result).not.toContain("qwerty");
  });
});

describe("cleanLogLine", () => {
  it("strips timestamps, ANSI codes, and GitHub group markers", () => {
    const raw = "\u001b[31m2024-01-15T10:00:00.1234567Z ##[group]Run npm test\u001b[0m";
    expect(cleanLogLine(raw)).toBe("Run npm test");
  });
});

describe("isFailureLine", () => {
  it("detects common failure markers", () => {
    expect(isFailureLine("FAIL src/index.test.ts")).toBe(true);
    expect(isFailureLine("Error: something broke")).toBe(true);
    expect(isFailureLine("npm ERR! test failed")).toBe(true);
    expect(isFailureLine("Tests: 2 failed, 5 passed")).toBe(true);
    expect(isFailureLine("AssertionError: expected true to be false")).toBe(true);
    expect(isFailureLine("ok 1 should be fine")).toBe(false);
  });
});

function buildLargeLog(): { log: string; failureBlock: string[] } {
  const failureBlock = [
    "2024-01-15T10:00:00.0000000Z ##[group]Run npm test",
    "2024-01-15T10:00:00.1000000Z npm test",
    "2024-01-15T10:00:01.0000000Z > daybreak@0.0.0 test",
    "2024-01-15T10:00:01.5000000Z > vitest run",
    "2024-01-15T10:00:02.0000000Z  FAIL  src/ci-logs.test.ts > parse",
    "2024-01-15T10:00:02.1000000Z   AssertionError: expected true to be false",
    "2024-01-15T10:00:02.2000000Z     at /workdir/src/ci-logs.test.ts:42:10",
    "2024-01-15T10:00:03.0000000Z  Tests: 1 failed, 0 passed",
    "2024-01-15T10:00:03.5000000Z npm ERR! Test failed. See above for details.",
    "2024-01-15T10:00:04.0000000Z ##[endgroup]",
  ];

  const lines: string[] = [];
  while (lines.join("\n").length < 100_000) {
    lines.push(`2024-01-15T09:59:59.${(lines.length % 1000).toString().padStart(3, "0")}Z irrelevant passing line ${lines.length}`);
  }
  lines.push(...failureBlock);

  return { log: lines.join("\n"), failureBlock };
}
