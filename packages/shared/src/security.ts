import { minimatch } from "minimatch";
import { resolve, sep, isAbsolute, normalize } from "node:path";

export interface SanitizedPath {
  ok: true;
  path: string;
}

export interface PathRejection {
  ok: false;
  reason: string;
}

export function sanitizePath(cwd: string, requestedPath: string): SanitizedPath | PathRejection {
  if (requestedPath.includes("\0")) {
    return { ok: false, reason: "Path contains a null byte" };
  }

  // Reject obvious traversal attempts before resolution so that symbolic or
  // escaped .. sequences do not slip through normalization.
  const rawSegments = requestedPath.split(/[\/\\]/);
  if (rawSegments.some((s) => s === "..")) {
    return { ok: false, reason: "Path contains '..' escape sequence" };
  }

  const absoluteCwd = resolve(cwd);
  const resolved = isAbsolute(requestedPath) ? normalize(requestedPath) : resolve(absoluteCwd, requestedPath);
  const withTrailing = absoluteCwd.endsWith(sep) ? absoluteCwd : `${absoluteCwd}${sep}`;

  if (resolved !== absoluteCwd && !resolved.startsWith(withTrailing)) {
    return { ok: false, reason: "Path resolves outside workspace" };
  }

  return { ok: true, path: resolved };
}

export function isSensitivePath(path: string, patterns: string[], cwd?: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\//, "");
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    if (
      minimatch(normalized, trimmed, { matchBase: true, dot: true }) ||
      minimatch(path, trimmed, { matchBase: true, dot: true })
    ) {
      return true;
    }
  }

  if (cwd !== undefined && isAbsolute(path)) {
    const check = sanitizePath(cwd, path);
    if (!check.ok) return true;
  }

  return false;
}

export function redactSecrets(text: string): string {
  let redacted = text;

  // URL credentials: https://user:pass@host
  redacted = redacted.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/g, "$1***:***@");

  // Query-string credentials before the generic key/value regex runs them together.
  redacted = redacted.replace(/([?&])(token|api[_-]?key|secret|password|credential)s?=[^&\s]+/gi, "$1$2=***");

  // Generic key/value patterns: KEY=..., KEY: ..., KEY="...", KEY='...'.
  redacted = redacted.replace(
    /(api[_-]?keys?|auth|bearer|passwords?|secrets?|tokens?|credentials?)(\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'&]{4,})/gi,
    "$1$2***",
  );

  // Bearer / Basic / Authorization header tokens.
  redacted = redacted.replace(/\b(bearer)\s+[^\s]+/gi, "$1 ***");
  redacted = redacted.replace(/(authorization:\s*(?:basic|bearer)\s+)[^\s]+/gi, "$1***");

  // GitHub tokens.
  redacted = redacted.replace(/\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g, "***");

  // AWS access key ids and secret access key assignments.
  redacted = redacted.replace(/\b(AKIA[0-9A-Z]{16})\b/g, "***");
  redacted = redacted.replace(/\b(aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*)[^\s&]+/gi, "$1***");

  // PEM / key blocks.
  redacted = redacted.replace(
    /-----BEGIN ([A-Z\s]+)-----[\s\S]*?-----END \1-----/gi,
    "-----BEGIN $1-----\n[REDACTED]\n-----END $1-----",
  );

  return redacted;
}
