import dotenv from "dotenv";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentConfig, LlmPricingMap } from "./types.js";

export interface DaybreakConfig {
  llm: AgentConfig;
  llmFallback?: AgentConfig;
  llmPricing: LlmPricingMap;
  maxTurns: number;
  maxWallClockMinutes: number;
  maxCostUsd: number;
  protectedBranches: string[];
  denylistPatterns: string[];
  requireApprovalForDestructive: boolean;
  compactionEnabled: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  e2bApiKey?: string;
  e2bTemplate?: string;
  githubToken?: string;
  githubAppId?: string;
  githubWebhookSecret?: string;
  githubWebhookRepoAllowlist?: string;
  githubWebhookRateLimit?: number;
  reviewKeepAliveMs?: number;
  upstashRedisRestUrl?: string;
  upstashRedisToken?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseBaseUrl?: string;
  checkpointInterval?: "turn" | "tool";
  sessionStoreBackend?: "file" | "supabase";
  forkStrategy?: "auto" | "snapshot" | "git-reinstall";
  maxCheckpointsPerTask?: number;
}

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_WALL_CLOCK_MINUTES = 20;
const DEFAULT_MAX_COST_USD = 0.5;
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];
const DEFAULT_COMPACTION_ENABLED = true;
const DEFAULT_COMPACTION_RESERVE_TOKENS = 4000;
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 8000;
const DEFAULT_CHECKPOINT_INTERVAL: "turn" | "tool" = "tool";
const DEFAULT_SESSION_STORE_BACKEND: "file" | "supabase" = "supabase";
const DEFAULT_FORK_STRATEGY: "auto" | "snapshot" | "git-reinstall" = "auto";
const DEFAULT_MAX_CHECKPOINTS_PER_TASK = 100;

export const DEFAULT_DENYLIST_PATTERNS: string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  ".ssh/**",
  ".git/config",
  "**/*secret*",
  "**/*token*",
  "**/*password*",
  "**/*credential*",
  ".npmrc",
  ".pypirc",
  "**/*.tfvars",
];

export function loadConfig(envPath?: string): DaybreakConfig {
  dotenv.config({ path: envPath ? resolve(envPath) : resolve(process.cwd(), ".env") });

  const get = (name: string): string | undefined => process.env[name];
  const requireString = (name: string): string => {
    const value = get(name);
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };

  const parseIntEnv = (name: string, fallback: number): number => {
    const value = get(name);
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  };

  const parseFloatEnv = (name: string, fallback: number): number => {
    const value = get(name);
    if (!value) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  };

  const parsePricingMap = (raw?: string): LlmPricingMap => {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as LlmPricingMap;
    } catch {
      return {};
    }
  };

  const primary: AgentConfig = {
    provider: (get("LLM_PROVIDER") as AgentConfig["provider"]) || "custom",
    baseUrl: get("LLM_BASE_URL") || "https://api.openai.com/v1",
    apiKey: get("LLM_API_KEY") || "",
    modelId: get("LLM_MODEL") || "gpt-4o-mini",
    inputPricePer1MTokens: parseFloatEnv("LLM_INPUT_PRICE_PER_1M", 0),
    outputPricePer1MTokens: parseFloatEnv("LLM_OUTPUT_PRICE_PER_1M", 0),
  };

  const fallback: AgentConfig | undefined = get("LLM_FALLBACK_BASE_URL")
    ? {
        provider: (get("LLM_FALLBACK_PROVIDER") as AgentConfig["provider"]) || "custom",
        baseUrl: get("LLM_FALLBACK_BASE_URL") || primary.baseUrl,
        apiKey: get("LLM_FALLBACK_API_KEY") || primary.apiKey,
        modelId: get("LLM_FALLBACK_MODEL") || primary.modelId,
        inputPricePer1MTokens: parseFloatEnv("LLM_FALLBACK_INPUT_PRICE_PER_1M", 0),
        outputPricePer1MTokens: parseFloatEnv("LLM_FALLBACK_OUTPUT_PRICE_PER_1M", 0),
      }
    : undefined;

  const protectedBranches = get("PROTECTED_BRANCHES")
    ? get("PROTECTED_BRANCHES")!.split(",").map((b) => b.trim()).filter(Boolean)
    : DEFAULT_PROTECTED_BRANCHES;

  const denylistPatterns = get("DENYLIST_PATTERNS")
    ? get("DENYLIST_PATTERNS")!.split(",").map((p) => p.trim()).filter(Boolean)
    : DEFAULT_DENYLIST_PATTERNS;

  const compactionEnabled = get("COMPACTION_ENABLED") !== "false";

  return {
    llm: primary,
    llmFallback: fallback,
    maxTurns: parseIntEnv("MAX_TURNS", DEFAULT_MAX_TURNS),
    maxWallClockMinutes: parseIntEnv("MAX_WALL_CLOCK_MINUTES", DEFAULT_MAX_WALL_CLOCK_MINUTES),
    maxCostUsd: parseFloatEnv("MAX_COST_USD", DEFAULT_MAX_COST_USD),
    protectedBranches,
    denylistPatterns,
    requireApprovalForDestructive: get("REQUIRE_APPROVAL_FOR_DESTRUCTIVE") !== "false",
    compactionEnabled,
    compactionReserveTokens: parseIntEnv("COMPACTION_RESERVE_TOKENS", DEFAULT_COMPACTION_RESERVE_TOKENS),
    compactionKeepRecentTokens: parseIntEnv("COMPACTION_KEEP_RECENT_TOKENS", DEFAULT_COMPACTION_KEEP_RECENT_TOKENS),
    llmPricing: parsePricingMap(get("LLM_PRICING")),
    daytonaApiKey: get("DAYTONA_API_KEY"),
    daytonaApiUrl: get("DAYTONA_API_URL"),
    daytonaTarget: get("DAYTONA_TARGET"),
    e2bApiKey: get("E2B_API_KEY"),
    e2bTemplate: get("E2B_TEMPLATE") || "base",
    githubToken: get("GITHUB_TOKEN"),
    githubAppId: get("GITHUB_APP_ID"),
    githubWebhookSecret: get("GITHUB_WEBHOOK_SECRET"),
    githubWebhookRepoAllowlist: get("GITHUB_WEBHOOK_REPO_ALLOWLIST"),
    githubWebhookRateLimit: parseIntEnv("GITHUB_WEBHOOK_RATE_LIMIT", 10),
    reviewKeepAliveMs: parseIntEnv("REVIEW_KEEP_ALIVE_MS", 15 * 60 * 1000),
    upstashRedisRestUrl: get("UPSTASH_REDIS_REST_URL"),
    upstashRedisToken: get("UPSTASH_REDIS_TOKEN"),
    supabaseUrl: get("SUPABASE_URL"),
    supabaseServiceKey: get("SUPABASE_SERVICE_KEY"),
    langfusePublicKey: get("LANGFUSE_PUBLIC_KEY"),
    langfuseSecretKey: get("LANGFUSE_SECRET_KEY"),
    langfuseBaseUrl: get("LANGFUSE_BASE_URL"),
    checkpointInterval: (get("DAYBREAK_CHECKPOINT_INTERVAL") as "turn" | "tool") || DEFAULT_CHECKPOINT_INTERVAL,
    sessionStoreBackend: (get("DAYBREAK_SESSION_STORE_BACKEND") as "file" | "supabase") || DEFAULT_SESSION_STORE_BACKEND,
    forkStrategy: (get("DAYBREAK_FORK_STRATEGY") as "auto" | "snapshot" | "git-reinstall") || DEFAULT_FORK_STRATEGY,
    maxCheckpointsPerTask: parseIntEnv("DAYBREAK_MAX_CHECKPOINTS_PER_TASK", DEFAULT_MAX_CHECKPOINTS_PER_TASK),
  };
}

export function getAgentDir(): string {
  return resolve(homedir(), ".daybreak", "agent");
}
