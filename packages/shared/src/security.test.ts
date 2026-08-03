import { describe, it, expect } from "vitest";
import { isSensitivePath, sanitizePath, redactSecrets } from "./security.js";

const patterns = [".env", ".env.*", "*.pem", ".ssh/**", "**/*secret*"];

const testCwd = "/workspace/project";

describe("sanitizePath", () => {
  it("allows paths inside the workspace", () => {
    expect(sanitizePath(testCwd, "src/index.ts")).toEqual({ ok: true, path: "/workspace/project/src/index.ts" });
  });

  it("rejects '..' escape sequences", () => {
    const result = sanitizePath(testCwd, "../.env");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'..'");
  });

  it("rejects absolute paths outside the workspace", () => {
    const result = sanitizePath(testCwd, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("outside workspace");
  });

  it("allows absolute paths inside the workspace", () => {
    const result = sanitizePath(testCwd, "/workspace/project/package.json");
    expect(result).toEqual({
      ok: true,
      path: "/workspace/project/package.json",
    });
  });
});

describe("isSensitivePath", () => {
  it("matches denylist patterns", () => {
    expect(isSensitivePath(".env", patterns)).toBe(true);
    expect(isSensitivePath("packages/app/.env", patterns)).toBe(true);
  });

  it("returns false for normal source files", () => {
    expect(isSensitivePath("src/index.ts", patterns)).toBe(false);
  });

  it("rejects absolute paths outside cwd when a cwd is provided", () => {
    expect(isSensitivePath("/etc/passwd", patterns, testCwd)).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("redacts URL credentials", () => {
    const text = "https://user:secret@github.com/repo.git";
    expect(redactSecrets(text)).toBe("https://***:***@github.com/repo.git");
  });

  it("redacts token and api_key values", () => {
    expect(redactSecrets("api_key=abc123secret")).toBe("api_key=***");
    expect(redactSecrets("token=ghp_xxx")).toBe("token=***");
  });

  it("redacts GitHub tokens", () => {
    const text = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123";
    expect(redactSecrets(text)).toBe("GITHUB_TOKEN=***");
  });

  it("redacts bearer and authorization tokens", () => {
    expect(redactSecrets("Authorization: Bearer ghp_xxx")).toBe("Authorization: Bearer ***");
    expect(redactSecrets("bearer ghp_xxx")).toBe("bearer ***");
  });

  it("redacts PEM blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toContain("[REDACTED]");
  });

  it("redacts AWS access keys", () => {
    const text = "AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(text)).toBe("***");
  });
});

describe("git protected branch detection", () => {
  const protectedBranches = ["main", "master"];

  function isGitCommandOnProtectedBranch(command: string): boolean {
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
        const branch = match[1].trim().replace(/^\+/, "").split(":").pop();
        if (branch && !branch.startsWith("origin/") && !branch.startsWith("--") && protectedBranches.includes(branch)) {
          return true;
        }
      }
    }
    return false;
  }

  it("detects git switch to protected branch", () => {
    expect(isGitCommandOnProtectedBranch("git switch main")).toBe(true);
  });

  it("detects git merge of protected branch", () => {
    expect(isGitCommandOnProtectedBranch("git merge main")).toBe(true);
  });

  it("detects refspec deletion of protected branch", () => {
    expect(isGitCommandOnProtectedBranch("git push origin :main")).toBe(true);
    expect(isGitCommandOnProtectedBranch("git push origin --delete main")).toBe(true);
  });

  it("does not flag feature branches", () => {
    expect(isGitCommandOnProtectedBranch("git switch feature/x")).toBe(false);
  });
});
