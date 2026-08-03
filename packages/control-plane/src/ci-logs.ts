export interface Annotation {
  path: string;
  start_line: number;
  message: string;
  title?: string;
}

export interface CheckRunOutput {
  title?: string | null;
  summary?: string | null;
  text?: string | null;
}

export interface CiLogParserOptions {
  contextLines?: number;
  maxFailureBlocks?: number;
}

export interface CiLogFetcherOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

type GitHubAnnotation = {
  path?: string;
  start_line?: number;
  end_line?: number;
  annotation_level?: string;
  message?: string;
  title?: string;
  raw_details?: string;
};

const GITHUB_API_VERSION = "2022-11-28";

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/;
const GROUP_MARKER_RE = /^(##\[(?:group|endgroup|debug|warning|error|section)\])\s*/;
const WORKFLOW_COMMAND_RE = /^::(?:group|endgroup|debug|warning|error)(?:\.title=[^:]*)?::/;

const FAILURE_PATTERNS: RegExp[] = [
  /Error:/i,
  /error:/i,
  /npm ERR!/i,
  /Tests: .*failed/i,
  /Test Files .* failed/i,
  /AssertionError/i,
  /\bFAIL\b/,
  /\bFAILED\b/,
  /[\u2715\u2716\u00D7]/,
];

export function cleanLogLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE_RE, "")
    .replace(TIMESTAMP_RE, "")
    .replace(GROUP_MARKER_RE, "")
    .replace(WORKFLOW_COMMAND_RE, "")
    .replace(/\s+$/g, "");
}

export function isFailureLine(line: string): boolean {
  return FAILURE_PATTERNS.some((pattern) => pattern.test(line));
}

export function redactSecrets(text: string): string {
  // URL credentials first: https://user:pass@host
  let redacted = text.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/g, "$1***:***@");

  // Query-string credentials before the generic key/value regex runs them together.
  redacted = redacted.replace(/([?&])(token|api[_-]?key|secret|password|credential)s?=[^&\s]+/gi, "$1$2=***");

  // Generic key/value patterns: KEY=..., KEY: ..., KEY="...", etc.
  // Unquoted values stop at whitespace, quotes, or '&' so URL query params are not merged.
  redacted = redacted.replace(
    /(api[_-]?keys?|auth|bearer|passwords?|secrets?|tokens?|credentials?)(\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'&]{4,})/gi,
    "$1$2***",
  );

  // Bearer tokens in headers or elsewhere (preserve the original casing of "Bearer")
  redacted = redacted.replace(/\b(bearer)\s+[^\s]+/gi, "$1 ***");

  return redacted;
}

export class CiLogParser {
  private contextLines: number;
  private maxFailureBlocks: number;

  constructor(options: CiLogParserOptions = {}) {
    this.contextLines = options.contextLines ?? 20;
    this.maxFailureBlocks = options.maxFailureBlocks ?? 3;
  }

  parseErrorContext(logs: string, annotations: Annotation[] = [], output?: CheckRunOutput): string {
    const rawLines = logs.split("\n");
    const cleanedLines = rawLines.map((line) => cleanLogLine(line));

    const failureIndices: number[] = [];
    for (let i = 0; i < cleanedLines.length; i++) {
      if (isFailureLine(cleanedLines[i])) {
        failureIndices.push(i);
      }
    }

    const blocks: Array<{ start: number; end: number }> = [];
    for (const idx of failureIndices) {
      const start = Math.max(0, idx - this.contextLines);
      const end = Math.min(cleanedLines.length, idx + this.contextLines + 1);
      if (blocks.length === 0) {
        blocks.push({ start, end });
        continue;
      }
      const last = blocks[blocks.length - 1];
      if (start <= last.end) {
        last.end = Math.max(last.end, end);
      } else {
        blocks.push({ start, end });
      }
    }

    const keptBlocks = blocks.slice(0, this.maxFailureBlocks);

    const sections: string[] = [];

    if (output?.title || output?.summary) {
      const title = output.title ? `Title: ${output.title}` : "";
      const summary = output.summary ? `Summary: ${output.summary}` : "";
      sections.push(`Check output:\n${[title, summary].filter(Boolean).join("\n")}`);
    }

    if (output?.text) {
      sections.push(`Check output text:\n${output.text}`);
    }

    if (annotations.length > 0) {
      sections.push(
        `Annotations:\n${annotations
          .map((a) => `- ${a.path}:${a.start_line}: ${a.title ? `[${a.title}] ` : ""}${a.message}`)
          .join("\n")}`,
      );
    }

    for (const block of keptBlocks) {
      const blockLines = cleanedLines.slice(block.start, block.end);
      sections.push("---\n" + blockLines.join("\n"));
    }

    const result = sections.join("\n\n");
    return redactSecrets(result);
  }
}

export class CiLogFetcher {
  private token: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(token: string, options: CiLogFetcherOptions = {}) {
    this.token = token;
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "https://api.github.com";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private githubHeaders(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "daybreak-control-plane",
    };
  }

  async fetchAnnotations(owner: string, repo: string, checkRunId: string | number): Promise<Annotation[]> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`;
    const res = await this.fetchImpl(url, { headers: this.githubHeaders() });
    if (!res.ok) {
      throw new Error(`GitHub annotations request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GitHubAnnotation[];
    if (!Array.isArray(data)) return [];
    return data
      .filter((a) => a.annotation_level === "failure")
      .map((a) => ({
        path: a.path ?? "",
        start_line: a.start_line ?? 0,
        message: a.message ?? "",
        title: a.title,
      }));
  }

  async fetchJobLogs(owner: string, repo: string, jobId: string | number, maxBytes?: number): Promise<string> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
    const res = await this.fetchImpl(url, { headers: this.githubHeaders() });
    if (!res.ok) {
      throw new Error(`GitHub job logs request failed: ${res.status} ${res.statusText}`);
    }
    let text = await res.text();

    if (maxBytes !== undefined && maxBytes > 0 && text.length > maxBytes) {
      const start = Math.max(0, text.length - maxBytes);
      // Move to the next line boundary so the first line isn't truncated.
      const nextNewline = text.indexOf("\n", start);
      text = nextNewline === -1 ? text.slice(start) : text.slice(nextNewline + 1);
    }

    return text;
  }
}
