import { createSign, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type DaybreakConfig } from "@daybreak/shared";

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: "all" | "selected";
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Resolve a relative path by walking up the directory tree from cwd.
 * Handles monorepo packages that run from a subdirectory but reference
 * paths relative to the repo root (where .env lives).
 */
function resolveFromCwd(relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), relativePath);
}

function getPrivateKey(config: DaybreakConfig): string | undefined {
  if (config.githubAppPrivateKey) {
    return config.githubAppPrivateKey.replace(/\\n/g, "\n");
  }
  if (config.githubAppPrivateKeyPath) {
    const keyPath = resolveFromCwd(config.githubAppPrivateKeyPath);
    try {
      return readFileSync(keyPath, "utf-8").trim();
    } catch (err) {
      console.error(`[github-app] failed to read private key from ${keyPath}:`, err);
      return undefined;
    }
  }
  return undefined;
}

/**
 * Mint a GitHub App JWT (RS256) signed with the app's private key.
 * The JWT is valid for 10 minutes (GitHub max is 10 min).
 */
function mintAppJwt(config: DaybreakConfig): string {
  const privateKey = getPrivateKey(config);
  if (!privateKey) throw new Error("GitHub App private key not configured");
  if (!config.githubAppId) throw new Error("GITHUB_APP_ID not configured");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // backdate 60s to account for clock skew
    exp: now + 10 * 60, // 10 min expiry (GitHub max)
    iss: config.githubAppId,
  };

  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Fetch an installation access token from GitHub.
 * Uses an in-memory cache to avoid re-fetching within the token's lifetime.
 */
export async function getInstallationToken(config?: DaybreakConfig): Promise<string | null> {
  const cfg = config ?? loadConfig();

  if (!cfg.githubAppId || !cfg.githubInstallationId) {
    return null;
  }

  // Return cached token if still valid
  if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }

  try {
    const jwt = mintAppJwt(cfg);
    const res = await fetch(
      `https://api.github.com/app/installations/${cfg.githubInstallationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      console.error(`[github-app] installation token fetch failed: ${res.status} ${text}`);
      return null;
    }

    const data = (await res.json()) as InstallationTokenResponse;
    const expiresAt = new Date(data.expires_at).getTime();
    cachedToken = { token: data.token, expiresAt };
    return data.token;
  } catch (err) {
    console.error("[github-app] installation token error:", err);
    return null;
  }
}

export interface GithubRepo {
  fullName: string;
  url: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

interface GithubApiRepo {
  full_name: string;
  clone_url: string;
  html_url: string;
  owner: { login: string };
  name: string;
  default_branch: string;
  private: boolean;
}

/**
 * List all repositories accessible to the GitHub App installation.
 * Paginates through all pages (100 per page).
 */
export async function listInstallationRepos(config?: DaybreakConfig): Promise<GithubRepo[] | null> {
  const cfg = config ?? loadConfig();
  const token = await getInstallationToken(cfg);
  if (!token) return null;

  const repos: GithubRepo[] = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const res = await fetch(
        `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown");
        console.error(`[github-app] list repos failed (page ${page}): ${res.status} ${text}`);
        return null;
      }

      const data = (await res.json()) as { repositories: GithubApiRepo[]; total_count: number };
      const pageRepos = data.repositories || [];
      for (const r of pageRepos) {
        repos.push({
          fullName: r.full_name,
          url: r.clone_url || r.html_url,
          owner: r.owner?.login || "",
          name: r.name || "",
          defaultBranch: r.default_branch || "main",
          private: r.private,
        });
      }

      if (pageRepos.length < perPage || repos.length >= (data.total_count || 0)) break;
      page++;
      // Safety cap at 500 repos
      if (page > 6) break;
    }

    return repos;
  } catch (err) {
    console.error("[github-app] list repos error:", err);
    return null;
  }
}

/**
 * Invalidate the cached installation token (e.g., after a 401).
 */
export function invalidateInstallationToken(): void {
  cachedToken = null;
}
