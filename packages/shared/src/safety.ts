import { statSync, readFileSync } from "node:fs";
import type { DaybreakConfig } from "./config.js";
import { isSensitivePath, sanitizePath } from "./security.js";

export interface SafetyCheck {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
  code?: string;
}

export function isProtectedBranch(branch: string, protectedBranches: string[]): boolean {
  return protectedBranches.includes(branch);
}

export function isDestructiveBash(args: unknown): SafetyCheck {
  const command = extractString(args, "command") || "";
  const lower = command.toLowerCase();

  const destructiveSubstrings = [
    "rm -rf /",
    "rm -rf ~",
    "> /dev/sd",
    "dd if=",
    "mkfs.",
    ":(){ :|:& };:",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "init 0",
  ];

  for (const needle of destructiveSubstrings) {
    if (lower.includes(needle)) {
      return { allowed: false, reason: `Destructive command pattern blocked: ${needle}` };
    }
  }

  return { allowed: true };
}

export function isGitCommandOnProtectedBranch(args: unknown, protectedBranches: string[]): SafetyCheck {
  const command = extractString(args, "command") || "";
  const lower = command.toLowerCase().trim();

  if (!lower.startsWith("git ")) return { allowed: true };

  const targetBranch = parseGitBranchArg(command);
  if (targetBranch && isProtectedBranch(targetBranch, protectedBranches)) {
    return {
      allowed: false,
      reason: `Git command targets protected branch '${targetBranch}'`,
    };
  }

  if (/(git\s+push\s+.*\+?\s*--force|git\s+push\s+-f)/.test(lower)) {
    return { allowed: false, reason: "Force push is not allowed" };
  }

  return { allowed: true };
}

function parseGitBranchArg(command: string): string | undefined {
  const patterns = [
    /git\s+checkout\s+(?:-b\s+)?([^\s&|;]+)/i,
    /git\s+switch\s+(?:-c\s+)?([^\s&|;]+)/i,
    /git\s+merge\s+([^\s&|;]+)/i,
    /git\s+push\s+[^\s]*\s+--delete\s+([^\s&|;]+)/i,
    /git\s+push\s+[^\s]*\s+:([^\s&|;]+)/i,
    /git\s+push\s+[^\s]*\s+([^\s:&|;]+)/i,
    /git\s+reset\s+[^\s]*\s+([^\s&|;]+)/i,
    /git\s+branch\s+(?:-D\s+|-d\s+)?([^\s&|;]+)/i,
  ];

  for (const re of patterns) {
    const match = command.match(re);
    if (match?.[1]) {
      const branch = match[1].trim();
      if (!branch.startsWith("origin/") && !branch.startsWith("--")) {
        return branch.replace(/^\+/, "").split(":").pop();
      }
    }
  }
  return undefined;
}

function extractString(args: unknown, key: string): string | undefined {
  if (args && typeof args === "object" && key in args) {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function tokenizeCommand(command: string): string[] {
  return command
    .split(/[\s;|&<>()`"'\\$]+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ""))
    .filter((t) => t.length > 0);
}

function looksLikePath(token: string): boolean {
  // Commit messages like "fix password validation" have no separators.
  // Path-like tokens contain a directory separator, a dot, or a leading ~.
  return /[\/\\.]/.test(token) || token.startsWith("~");
}

function commandContainsUnsafeToken(command: string, patterns: string[], cwd: string): SafetyCheck {
  for (const token of tokenizeCommand(command)) {
    if (!looksLikePath(token)) continue;

    if (isSensitivePath(token, patterns)) {
      return { allowed: false, reason: `Command references a sensitive path matching the denylist` };
    }

    const sanitized = sanitizePath(cwd, token);
    if (!sanitized.ok) {
      return { allowed: false, reason: `Command references a path outside the workspace: ${sanitized.reason}` };
    }
  }
  return { allowed: true };
}

export class SafetyMiddleware {
  private config: DaybreakConfig;
  private approvedCommands = new Set<string>();
  private cwd?: string;
  private autoApproveAll = false;

  constructor(config: DaybreakConfig) {
    this.config = config;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  approveAll(): void {
    this.autoApproveAll = true;
  }

  beforeToolCall(toolName: string, args: unknown): SafetyCheck {
    const cwd = this.cwd ?? process.cwd();
    const path = this.extractPath(args);

    if (path) {
      const sanitized = sanitizePath(cwd, path);
      if (!sanitized.ok) {
        return { allowed: false, reason: sanitized.reason };
      }
      if (isSensitivePath(sanitized.path, this.config.denylistPatterns)) {
        return {
          allowed: false,
          reason: `Path '${path}' matches the sensitive-file denylist`,
        };
      }

      if (["read", "write", "edit"].includes(toolName)) {
        const sizeCheck = this.checkFileSize(sanitized.path);
        if (!sizeCheck.allowed) return sizeCheck;
      }
    }

    if (toolName === "bash") {
      const destructive = isDestructiveBash(args);
      if (!destructive.allowed) return destructive;

      const command = extractString(args, "command") || "";
      const unsafeToken = commandContainsUnsafeToken(command, this.config.denylistPatterns, cwd);
      if (!unsafeToken.allowed) return unsafeToken;

      const protectedBranch = isGitCommandOnProtectedBranch(args, this.config.protectedBranches);
      if (!protectedBranch.allowed) return protectedBranch;

      if (this.isDestructiveOrDelivery(args) && this.config.requireApprovalForDestructive && !this.autoApproveAll) {
        const key = this.getApprovalKey(toolName, args);
        if (!this.approvedCommands.has(key)) {
          return {
            allowed: true,
            requiresApproval: true,
            reason: `Command requires explicit approval: ${command}`,
          };
        }
      }
    }

    if ((toolName === "write" || toolName === "edit") && this.config.requireApprovalForDestructive && !this.autoApproveAll) {
      const key = this.getApprovalKey(toolName, args);
      if (!this.approvedCommands.has(key)) {
        return {
          allowed: true,
          requiresApproval: true,
          reason: `File ${toolName} requires explicit approval: ${path || "unknown"}`,
        };
      }
    }

    return { allowed: true };
  }

  approveCommand(command: string): void {
    this.approvedCommands.add(this.getApprovalKey("bash", { command }));
  }

  private getApprovalKey(toolName: string, args: unknown): string {
    if (toolName === "bash") {
      const command = extractString(args, "command") || "";
      return `bash:${command}`;
    }
    const path = this.extractPath(args) || JSON.stringify(args);
    return `${toolName}:${path}`;
  }

  private isDestructiveOrDelivery(args: unknown): boolean {
    const command = (extractString(args, "command") || "").toLowerCase();
    const patterns = [
      /^\s*git\s+push/,
      /^\s*git\s+branch\s+-D/,
      /^\s*git\s+branch\s+-d/,
      /^\s*rm\s+-rf/,
      /^\s*rm\s+-r/,
      /^\s*git\s+push\s+.*--force/,
      /^\s*gh\s+pr\s+create/,
    ];
    return patterns.some((re) => re.test(command));
  }

  extractPath(args: unknown): string | undefined {
    const keys = ["path", "file_path", "target_path", "new_path", "old_path"];
    for (const key of keys) {
      const value = extractString(args, key);
      if (value) return value;
    }
    return undefined;
  }

  private checkFileSize(absPath: string): SafetyCheck {
    try {
      const stats = statSync(absPath);
      if (!stats.isFile()) return { allowed: true };

      if (stats.size > this.config.maxFileReadBytes) {
        return {
          allowed: false,
          reason: `File too large: ${stats.size} bytes exceeds max ${this.config.maxFileReadBytes}`,
          code: "file_too_large",
        };
      }

      const content = readFileSync(absPath, "utf8");
      const lines = content.split("\n").length;
      if (lines > this.config.maxFileReadLines) {
        return {
          allowed: false,
          reason: `File too many lines: ${lines} exceeds max ${this.config.maxFileReadLines}`,
          code: "file_too_large",
        };
      }
    } catch {
      // File may not exist yet (e.g. a write of a new file); allow the tool call.
    }
    return { allowed: true };
  }
}
