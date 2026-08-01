import dotenv from "dotenv";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentConfig } from "./types.js";

export interface DaybreakConfig {
  llm: AgentConfig;
  llmFallback?: AgentConfig;
  maxTurns: number;
  maxWallClockMinutes: number;
  maxCostUsd: number;
  protectedBranches: string[];
  denylistPatterns: string[];
  requireApprovalForDestructive: boolean;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  githubToken?: string;
  githubAppId?: string;
  githubWebhookSecret?: string;
  upstashRedisRestUrl?: string;
  upstashRedisToken?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseBaseUrl?: string;
}

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_WALL_CLOCK_MINUTES = 20;
const DEFAULT_MAX_COST_USD = 0.5;
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

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

  const primary: AgentConfig = {
    provider: (get("LLM_PROVIDER") as AgentConfig["provider"]) || "custom",
    baseUrl: get("LLM_BASE_URL") || "https://api.openai.com/v1",
    apiKey: get("LLM_API_KEY") || "",
    modelId: get("LLM_MODEL") || "gpt-4o-mini",
  };

  const fallback: AgentConfig | undefined = get("LLM_FALLBACK_BASE_URL")
    ? {
        provider: (get("LLM_FALLBACK_PROVIDER") as AgentConfig["provider"]) || "custom",
        baseUrl: get("LLM_FALLBACK_BASE_URL") || primary.baseUrl,
        apiKey: get("LLM_FALLBACK_API_KEY") || primary.apiKey,
        modelId: get("LLM_FALLBACK_MODEL") || primary.modelId,
      }
    : undefined;

  const protectedBranches = get("PROTECTED_BRANCHES")
    ? get("PROTECTED_BRANCHES")!.split(",").map((b) => b.trim()).filter(Boolean)
    : DEFAULT_PROTECTED_BRANCHES;

  const denylistPatterns = get("DENYLIST_PATTERNS")
    ? get("DENYLIST_PATTERNS")!.split(",").map((p) => p.trim()).filter(Boolean)
    : DEFAULT_DENYLIST_PATTERNS;

  return {
    llm: primary,
    llmFallback: fallback,
    maxTurns: parseIntEnv("MAX_TURNS", DEFAULT_MAX_TURNS),
    maxWallClockMinutes: parseIntEnv("MAX_WALL_CLOCK_MINUTES", DEFAULT_MAX_WALL_CLOCK_MINUTES),
    maxCostUsd: parseFloatEnv("MAX_COST_USD", DEFAULT_MAX_COST_USD),
    protectedBranches,
    denylistPatterns,
    requireApprovalForDestructive: get("REQUIRE_APPROVAL_FOR_DESTRUCTIVE") !== "false",
    daytonaApiKey: get("DAYTONA_API_KEY"),
    daytonaApiUrl: get("DAYTONA_API_URL"),
    daytonaTarget: get("DAYTONA_TARGET"),
    githubToken: get("GITHUB_TOKEN"),
    githubAppId: get("GITHUB_APP_ID"),
    githubWebhookSecret: get("GITHUB_WEBHOOK_SECRET"),
    upstashRedisRestUrl: get("UPSTASH_REDIS_REST_URL"),
    upstashRedisToken: get("UPSTASH_REDIS_TOKEN"),
    supabaseUrl: get("SUPABASE_URL"),
    supabaseServiceKey: get("SUPABASE_SERVICE_KEY"),
    langfusePublicKey: get("LANGFUSE_PUBLIC_KEY"),
    langfuseSecretKey: get("LANGFUSE_SECRET_KEY"),
    langfuseBaseUrl: get("LANGFUSE_BASE_URL"),
  };
}

export function getAgentDir(): string {
  return resolve(homedir(), ".daybreak", "agent");
}
