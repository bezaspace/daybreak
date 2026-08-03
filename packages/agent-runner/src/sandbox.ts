#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { CommandExitError, Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { createStreamPublisher } from "./stream.js";

function getArg(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
}

function hasArg(name: string): boolean {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

const NODE22_URL = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz";
const WORK_DIR = "/home/user";
const NODE_DIR = `${WORK_DIR}/.node`;
const REMOTE_PATH = `${WORK_DIR}/run-task.cjs`;
const SETUP_TIMEOUT_MS = 180_000;
const BROWSER_INSTALL_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const e2bSnapshotId = getArg("--e2b-snapshot-id");
  const templateName = e2bSnapshotId || getArg("--template") || config.e2bTemplate || "base";
  const isBaseTemplate = templateName === "base";
  const targetRepo = getArg("--repo") || "https://github.com/bezaspace/daybreak-target";
  const targetBranch = getArg("--branch") || "main";
  const prBranch = getArg("--pr-branch") || `daybreak/${randomUUID()}`;
  const taskId = getArg("--task-id") || randomUUID();
  const taskPrompt = getArg("--prompt");
  const rewindToCheckpoint = getArg("--rewind-to-checkpoint");
  const forkFromCheckpoint = getArg("--fork-from-checkpoint");
  const forkPrompt = getArg("--fork-prompt");
  const parentTaskId = getArg("--parent-task-id") || taskId;
  const connectId = getArg("--connect");
  const isReview = hasArg("--review");
  const isHeal = hasArg("--heal");
  const keepAlive = hasArg("--keep-alive");
  const fallbackCreate = hasArg("--fallback-create");
  const keepAliveMs = config.reviewKeepAliveMs ?? 15 * 60 * 1000;

  const envPushAfterFix = process.env.PUSH_AFTER_FIX;
  const argPushAfterFix = getArg("--push");
  const pushAfterFix =
    envPushAfterFix !== undefined
      ? envPushAfterFix !== "false"
      : argPushAfterFix !== "false";

  if (!config.e2bApiKey) {
    console.error(pc.red("E2B_API_KEY is required"));
    process.exit(1);
  }
  if (!config.githubToken) {
    console.error(pc.red("GITHUB_TOKEN is required"));
    process.exit(1);
  }

  const publisher = createStreamPublisher({
    upstashRedisRestUrl: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL,
    upstashRedisToken: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN,
    taskId,
  });

  const bundlePath = resolve(process.cwd(), "dist/run-task.cjs");
  const bundle = readFileSync(bundlePath, "utf8");

  const nodeBinPath = `${NODE_DIR}/bin`;

  const sandboxEnvs: Record<string, string> = {
    PATH: `${nodeBinPath}:/usr/local/bin:/usr/bin:/bin`,
    NODE_PATH: "/usr/local/lib/node_modules",
    LLM_PROVIDER: config.llm.provider,
    LLM_BASE_URL: config.llm.baseUrl,
    LLM_API_KEY: config.llm.apiKey,
    LLM_MODEL: config.llm.modelId,
    LLM_INPUT_PRICE_PER_1M: String(config.llm.inputPricePer1MTokens ?? 0),
    LLM_OUTPUT_PRICE_PER_1M: String(config.llm.outputPricePer1MTokens ?? 0),
    LLM_FALLBACK_PROVIDER: config.llmFallback?.provider || "",
    LLM_FALLBACK_BASE_URL: config.llmFallback?.baseUrl || "",
    LLM_FALLBACK_API_KEY: config.llmFallback?.apiKey || "",
    LLM_FALLBACK_MODEL: config.llmFallback?.modelId || "",
    LLM_FALLBACK_INPUT_PRICE_PER_1M: String(config.llmFallback?.inputPricePer1MTokens ?? 0),
    LLM_FALLBACK_OUTPUT_PRICE_PER_1M: String(config.llmFallback?.outputPricePer1MTokens ?? 0),
    LLM_PRICING: JSON.stringify(config.llmPricing),
    GITHUB_TOKEN: config.githubToken,
    TASK_ID: taskId,
    TARGET_REPO_URL: targetRepo,
    TARGET_BRANCH: targetBranch,
    TARGET_DIR: `${WORK_DIR}/target`,
    WORK_DIR,
    AUTO_APPROVE: "true",
    PUSH_AFTER_FIX: String(pushAfterFix),
    PR_BRANCH_NAME: prBranch,
    TASK_PROMPT: taskPrompt || "",
    REVIEW_MODE: String(isReview || isHeal),
    HEAL_MODE: String(isHeal),
    REWIND_TO_CHECKPOINT: rewindToCheckpoint || "",
    FORK_FROM_CHECKPOINT: forkFromCheckpoint || "",
    FORK_SOURCE_BRANCH: process.env.FORK_SOURCE_BRANCH || targetBranch,
    FORK_PROMPT: forkPrompt || "",
    PARENT_TASK_ID: parentTaskId,
    PW_EXECUTABLE_PATH: "/usr/bin/chromium",
    PLAYWRIGHT_BROWSERS_PATH: "0",
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || "",
    LANGFUSE_PUBLIC_KEY: config.langfusePublicKey || "",
    LANGFUSE_SECRET_KEY: config.langfuseSecretKey || "",
    LANGFUSE_BASE_URL: config.langfuseBaseUrl || "",
    SUPABASE_URL: config.supabaseUrl || "",
    SUPABASE_SERVICE_KEY: config.supabaseServiceKey || "",
    MAX_TURNS: String(config.maxTurns),
    MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
    MAX_COST_USD: String(config.maxCostUsd),
    DAYBREAK_CHECKPOINT_INTERVAL: config.checkpointInterval || "tool",
    DAYBREAK_SESSION_STORE_BACKEND: config.sessionStoreBackend || "supabase",
    DAYBREAK_FORK_STRATEGY: config.forkStrategy || "auto",
    DAYBREAK_MAX_CHECKPOINTS_PER_TASK: String(config.maxCheckpointsPerTask ?? 100),
    REQUIRE_APPROVAL_FOR_DESTRUCTIVE: "false",
    DENYLIST_PATTERNS: config.denylistPatterns.join(","),
    COMPACTION_ENABLED: String(config.compactionEnabled),
    COMPACTION_RESERVE_TOKENS: String(config.compactionReserveTokens),
    COMPACTION_KEEP_RECENT_TOKENS: String(config.compactionKeepRecentTokens),
  };

  async function getSandbox(): Promise<Sandbox> {
    if (connectId) {
      try {
        console.log(pc.bold(`[sandbox] connecting to ${connectId}...`));
        const sbx = await Sandbox.connect(connectId, { apiKey: config.e2bApiKey });
        console.log(pc.bold(`[sandbox] connected to ${sbx.sandboxId}`));
        publisher.publish("sandbox_resumed", { sandboxId: sbx.sandboxId, taskId, repo: targetRepo, branch: targetBranch, prBranch, isReview, isHeal });
        return sbx;
      } catch (error) {
        if (fallbackCreate) {
          console.warn(pc.yellow(`[sandbox] connect failed, falling back to create: ${error}`));
        } else {
          throw error;
        }
      }
    }
    console.log(pc.bold(`[sandbox] creating E2B sandbox from template ${templateName}...`));
    const sbx = await Sandbox.create({
      template: templateName,
      allowInternetAccess: true,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      apiKey: config.e2bApiKey,
      validateApiKey: false,
      envs: sandboxEnvs,
    });
    console.log(pc.bold(`[sandbox] created ${sbx.sandboxId} taskId=${taskId}`));
    publisher.publish("sandbox_created", { sandboxId: sbx.sandboxId, taskId, repo: targetRepo, branch: targetBranch, prBranch, isReview, isHeal });
    return sbx;
  }

  let sandbox: Sandbox;
  try {
    sandbox = await getSandbox();
  } catch (error) {
    console.error(pc.red("[sandbox] failed to get sandbox:"), error);
    publisher.publish("sandbox_error", { error: String(error), taskId });
    process.exit(1);
  }

  try {
    if (isBaseTemplate && !connectId) {
      console.log(pc.bold("[sandbox] installing Node 22..."));
      const setup = await sandbox.commands.run(
        `mkdir -p ${NODE_DIR} && curl -fsSL ${NODE22_URL} | tar -xJf - -C ${NODE_DIR} --strip-components=1 && ${NODE_DIR}/bin/node --version`,
        { timeoutMs: SETUP_TIMEOUT_MS },
      );
      if (setup.exitCode !== 0) {
        throw new Error(`Node 22 install failed:\n${setup.stdout}\n${setup.stderr}`);
      }
      process.stdout.write(setup.stdout.trim() + "\n");

      console.log(pc.bold("[sandbox] installing Chromium (browser tool)..."));
      const browserSetup = await sandbox.commands.run(
        "apt-get update -qq && apt-get install -y -qq chromium chromium-driver 2>&1 | tail -n 50",
        { timeoutMs: BROWSER_INSTALL_TIMEOUT_MS, user: "root" },
      );
      if (browserSetup.exitCode !== 0) {
        throw new Error(`Chromium install failed:\n${browserSetup.stdout}\n${browserSetup.stderr}`);
      }
      process.stdout.write(browserSetup.stdout.trim() + "\n");

      console.log(pc.bold("[sandbox] installing Playwright core..."));
      const pwSetup = await sandbox.commands.run(
        `cd ${WORK_DIR} && npm_config_loglevel=error npm_config_audit=false npm_config_fund=false ${NODE_DIR}/bin/npm install playwright-core 2>&1 | tail -n 30`,
        { timeoutMs: 120_000 },
      );
      if (pwSetup.exitCode !== 0) {
        throw new Error(`Playwright core install failed:\n${pwSetup.stdout}\n${pwSetup.stderr}`);
      }
      process.stdout.write(pwSetup.stdout.trim() + "\n");
    } else if (connectId) {
      console.log(pc.bold(`[sandbox] reusing existing template ${templateName}; skipping setup`));
    } else {
      console.log(pc.bold(`[sandbox] using pre-built template ${templateName}; skipping Node/Chromium install`));
    }

    if (rewindToCheckpoint) {
      console.log(pc.bold("[sandbox] killing existing run-task process before rewind"));
      await sandbox.commands.run(`pkill -f run-task.cjs || true`, { timeoutMs: 30_000 });
    }

    console.log(pc.bold("[sandbox] uploading agent bundle..."));
    await sandbox.files.write(REMOTE_PATH, bundle);

    if (isHeal) {
      console.log(pc.bold("[sandbox] running heal agent in sandbox..."));
      publisher.publish("heal_task_start", { sandboxId: sandbox.sandboxId, taskId, repo: targetRepo, branch: targetBranch, prBranch });
    } else if (isReview) {
      console.log(pc.bold("[sandbox] running review agent in sandbox..."));
      publisher.publish("review_task_start", { sandboxId: sandbox.sandboxId, taskId, repo: targetRepo, branch: targetBranch, prBranch });
    } else {
      console.log(pc.bold("[sandbox] running agent in sandbox..."));
    }

    const handle = await sandbox.commands.run(`${nodeBinPath}/node ${REMOTE_PATH}`, {
      background: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
      envs: sandboxEnvs,
      onStdout: (data: string) => {
        process.stdout.write(data);
      },
      onStderr: (data: string) => {
        process.stderr.write(data);
      },
    });

    const result = await handle.wait();
    process.exitCode = result.exitCode;
    console.log(pc.bold("\n[sandbox] exit:"), result.exitCode);

    if (keepAlive) {
      try {
        await sandbox.setTimeout(keepAliveMs);
        const keepAliveUntil = Date.now() + keepAliveMs;
        console.log(pc.bold(`[sandbox] keeping sandbox alive until ${new Date(keepAliveUntil).toISOString()}`));
        publisher.publish("sandbox_keep_alive", { sandboxId: sandbox.sandboxId, taskId, keepAliveMs, keepAliveUntil });
      } catch (error) {
        console.error(pc.yellow("[sandbox] keep-alive failed:"), error);
      }
    } else {
      console.log(pc.bold("[sandbox] deleting sandbox..."));
      try {
        await sandbox.kill();
      } catch {
        // ignore cleanup errors
      }
    }
  } catch (error) {
    if (error instanceof CommandExitError) {
      process.exitCode = error.exitCode;
    } else {
      process.exitCode = 1;
    }
    console.error(pc.red("[sandbox] error:"), error);
    try {
      await sandbox.kill();
    } catch {
      // ignore cleanup errors
    }
  } finally {
    try {
      await publisher.close();
    } catch {
      // ignore publisher cleanup errors
    }
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
