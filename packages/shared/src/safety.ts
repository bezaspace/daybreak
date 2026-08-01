import { minimatch } from "minimatch";
import type { DaybreakConfig } from "./config.js";

export interface SafetyCheck {
  allowed: boolean;
  reason?: string;
}

export function isSensitivePath(path: string, patterns: string[]): boolean {
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
  return false;
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

function commandContainsSensitivePath(command: string, patterns: string[]): boolean {
  // Tokenize a bash command and check any token that looks like a file path.
  // A token is treated as path-like if it contains a directory separator or a dot,
  // which avoids false positives on commit messages such as "fix password validation".
  const tokenize = (input: string): string[] =>
    input
      .split(/[\s;|&<>()`"'$\\]+/)
      .map((t) => t.replace(/^["']+|["']+$/g, ""))
      .filter((t) => t.length > 0);

  for (const token of tokenize(command)) {
    if (/[\/\\.]/.test(token) && isSensitivePath(token, patterns)) return true;
  }
  return false;
}

export class SafetyMiddleware {
  private config: DaybreakConfig;
  private approvedCommands = new Set<string>();

  private autoApproveAll = false;

  constructor(config: DaybreakConfig) {
    this.config = config;
  }

  approveAll(): void {
    this.autoApproveAll = true;
  }

  beforeToolCall(toolName: string, args: unknown): SafetyCheck {
    const path = this.extractPath(toolName, args);

    if (path && isSensitivePath(path, this.config.denylistPatterns)) {
      return {
        allowed: false,
        reason: `Path '${path}' matches the sensitive-file denylist`,
      };
    }

    if (toolName === "bash") {
      const destructive = isDestructiveBash(args);
      if (!destructive.allowed) return destructive;

      const command = extractString(args, "command") || "";
      if (commandContainsSensitivePath(command, this.config.denylistPatterns)) {
        return {
          allowed: false,
          reason: `Command references a sensitive path matching the denylist`,
        };
      }

      const protectedBranch = isGitCommandOnProtectedBranch(args, this.config.protectedBranches);
      if (!protectedBranch.allowed) return protectedBranch;
    }

    if (toolName === "bash" && this.isDestructiveOrDelivery(args)) {
      const command = extractString(args, "command") || "";
      if (this.config.requireApprovalForDestructive && !this.autoApproveAll && !this.approvedCommands.has(command)) {
        return {
          allowed: false,
          reason: `Command requires explicit approval: ${command}`,
        };
      }
    }

    return { allowed: true };
  }

  approveCommand(command: string): void {
    this.approvedCommands.add(command);
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
    ];
    return patterns.some((re) => re.test(command));
  }

  private extractPath(toolName: string, args: unknown): string | undefined {
    const keys = ["path", "file_path", "target_path", "new_path", "old_path"];
    if (toolName === "bash") {
      return extractString(args, "command");
    }
    for (const key of keys) {
      const value = extractString(args, key);
      if (value) return value;
    }
    return undefined;
  }
}
