#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { CommandExitError, Sandbox } from "e2b";
import { Den } from "@us4/den";
import type { Sandbox as DenSandbox, ExecResult } from "@us4/den";
import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { createReadStream, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import pc from "picocolors";
import { createStreamPublisher } from "./stream.js";

function getArg(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
}

function hasArg(name: string): boolean {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

const NODE22_URL = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz";
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const SETUP_TIMEOUT_MS = 180_000;
const BROWSER_INSTALL_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;

interface SandboxAdapter {
  id: string;
  run(cmd: string, opts?: {
    timeoutMs?: number;
    user?: string;
    env?: Record<string, string>;
    background?: boolean;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeFile(path: string, content: string): Promise<void>;
  setTimeout(ms: number): Promise<void>;
  kill(): Promise<void>;
}

function denExecToResult(result: ExecResult): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: result.exit_code, stdout: result.stdout, stderr: result.stderr };
}

function writeFileToContainer(containerName: string, filePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "den-write-"));
    const tmpPath = join(tmpDir, "file");
    writeFileSync(tmpPath, content);

    const child = spawn("docker", [
      "exec",
      "-i",
      containerName,
      "sh",
      "-c",
      'mkdir -p "$(dirname "$1")" && cat > "$1"',
      "--",
      filePath,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(tmpDir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(stderr.trim() || `docker exec exited with code ${code}`));
      } else {
        resolve();
      }
    });

    createReadStream(tmpPath).pipe(child.stdin);
  });
}

function createDenAdapter(sandbox: DenSandbox, workDir: string): SandboxAdapter {
  return {
    id: sandbox.id,
    async run(cmd, opts = {}) {
      const args = ["bash", "-c", cmd];
      const timeoutSec = opts.timeoutMs
        ? Math.min(Math.max(Math.ceil(opts.timeoutMs / 1000), 1), 300)
        : 300;
      const result = await sandbox.exec(args, {
        env: opts.env,
        timeout: timeoutSec,
        workdir: workDir,
      });
      if (opts.onStdout && result.stdout) opts.onStdout(result.stdout);
      if (opts.onStderr && result.stderr) opts.onStderr(result.stderr);
      return denExecToResult(result);
    },
    async writeFile(path, content) {
      // Den's HTTP writeFile has a small-body limit (~50 KB). Stream the
      // file into the sandbox container via docker exec instead.
      await writeFileToContainer(`den-${sandbox.id}`, path, content);
    },
    async setTimeout() {
      // Den manages sandbox lifetime at creation time; live extension is not exposed.
      console.warn(pc.yellow("[sandbox] setTimeout is not supported by Den; relying on creation timeout."));
    },
    async kill() {
      await sandbox.destroy();
    },
  };
}

async function getDenSandbox(
  config: ReturnType<typeof loadConfig>,
  workDir: string,
  sandboxEnvs: Record<string, string>,
  publisher: ReturnType<typeof createStreamPublisher>,
  connectId: string | undefined,
  e2bSnapshotId: string | undefined,
  image: string,
): Promise<SandboxAdapter> {
  const url = config.denUrl || "http://localhost:8080";
  const apiKey = config.denApiKey || "";
  const den = new Den({ url, apiKey });
  const timeoutSec = Math.floor(SANDBOX_TIMEOUT_MS / 1000);

  if (connectId) {
    try {
      const sandbox = await den.sandbox.get(connectId);
      console.log(pc.bold(`[sandbox] connected to Den sandbox ${sandbox.id}`));
      publisher.publish("sandbox_resumed", { sandboxId: sandbox.id, taskId: sandboxEnvs.TASK_ID, repo: sandboxEnvs.TARGET_REPO_URL, branch: sandboxEnvs.TARGET_BRANCH, prBranch: sandboxEnvs.PR_BRANCH_NAME });
      return createDenAdapter(sandbox, workDir);
    } catch (error) {
      if (hasArg("--fallback-create")) {
        console.warn(pc.yellow(`[sandbox] Den connect failed, falling back to create: ${error}`));
      } else {
        throw error;
      }
    }
  }

  if (e2bSnapshotId) {
    try {
      const sandbox = await den.sandbox.restoreSnapshot(e2bSnapshotId);
      console.log(pc.bold(`[sandbox] restored Den sandbox ${sandbox.id} from snapshot ${e2bSnapshotId}`));
      publisher.publish("sandbox_created", { sandboxId: sandbox.id, taskId: sandboxEnvs.TASK_ID, repo: sandboxEnvs.TARGET_REPO_URL, branch: sandboxEnvs.TARGET_BRANCH, prBranch: sandboxEnvs.PR_BRANCH_NAME });
      return createDenAdapter(sandbox, workDir);
    } catch (error) {
      console.warn(pc.yellow(`[sandbox] Den snapshot restore failed, falling back to create: ${error}`));
    }
  }

  const sandbox = await den.sandbox.create({
    image,
    env: sandboxEnvs,
    workdir: workDir,
    timeout: timeoutSec,
    memory: 536_870_912,
  });
  console.log(pc.bold(`[sandbox] created Den sandbox ${sandbox.id} taskId=${sandboxEnvs.TASK_ID}`));
  publisher.publish("sandbox_created", { sandboxId: sandbox.id, taskId: sandboxEnvs.TASK_ID, repo: sandboxEnvs.TARGET_REPO_URL, branch: sandboxEnvs.TARGET_BRANCH, prBranch: sandboxEnvs.PR_BRANCH_NAME });
  return createDenAdapter(sandbox, workDir);
}

function createE2BAdapter(sandbox: Sandbox): SandboxAdapter {
  return {
    id: sandbox.sandboxId,
    async run(cmd, opts = {}) {
      const handle = await sandbox.commands.run(cmd, {
        timeoutMs: opts.timeoutMs,
        envs: opts.env,
        user: opts.user,
        background: opts.background ?? false,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
      if ("wait" in handle && typeof (handle as { wait?: () => unknown }).wait === "function") {
        return (await (handle as { wait(): Promise<{ exitCode: number; stdout: string; stderr: string }> }).wait()) as { exitCode: number; stdout: string; stderr: string };
      }
      return handle as { exitCode: number; stdout: string; stderr: string };
    },
    async writeFile(path, content) {
      await sandbox.files.write(path, content);
    },
    async setTimeout(ms) {
      await sandbox.setTimeout(ms);
    },
    async kill() {
      await sandbox.kill();
    },
  };
}

async function getE2BSandbox(
  config: ReturnType<typeof loadConfig>,
  sandboxEnvs: Record<string, string>,
  publisher: ReturnType<typeof createStreamPublisher>,
  connectId: string | undefined,
  e2bSnapshotId: string | undefined,
): Promise<SandboxAdapter> {
  if (!config.e2bApiKey) {
    throw new Error("E2B_API_KEY is required");
  }

  const templateName = e2bSnapshotId || getArg("--template") || config.e2bTemplate || "base";

  if (connectId) {
    try {
      const sandbox = await Sandbox.connect(connectId, { apiKey: config.e2bApiKey });
      console.log(pc.bold(`[sandbox] connected to ${sandbox.sandboxId}`));
      publisher.publish("sandbox_resumed", { sandboxId: sandbox.sandboxId, taskId: sandboxEnvs.TASK_ID, repo: sandboxEnvs.TARGET_REPO_URL, branch: sandboxEnvs.TARGET_BRANCH, prBranch: sandboxEnvs.PR_BRANCH_NAME });
      return createE2BAdapter(sandbox);
    } catch (error) {
      if (hasArg("--fallback-create")) {
        console.warn(pc.yellow(`[sandbox] connect failed, falling back to create: ${error}`));
      } else {
        throw error;
      }
    }
  }

  console.log(pc.bold(`[sandbox] creating E2B sandbox from template ${templateName}...`));
  const sandbox = await Sandbox.create({
    template: templateName,
    allowInternetAccess: true,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey: config.e2bApiKey,
    validateApiKey: false,
    envs: sandboxEnvs,
  });
  console.log(pc.bold(`[sandbox] created ${sandbox.sandboxId} taskId=${sandboxEnvs.TASK_ID}`));
  publisher.publish("sandbox_created", { sandboxId: sandbox.sandboxId, taskId: sandboxEnvs.TASK_ID, repo: sandboxEnvs.TARGET_REPO_URL, branch: sandboxEnvs.TARGET_BRANCH, prBranch: sandboxEnvs.PR_BRANCH_NAME });
  return createE2BAdapter(sandbox);
}

async function main() {
  const config = loadConfig();
  const isLocal = config.mode === "local";
  const e2bSnapshotId = getArg("--e2b-snapshot-id");
  const templateName = e2bSnapshotId || getArg("--template") || config.e2bTemplate || "base";
  const isBaseTemplate = templateName === "base";
  const denImage = isLocal ? (isBaseTemplate ? "node:22" : templateName) : "ubuntu:22.04";
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

  if (isLocal) {
    if (!config.denUrl && !process.env.DEN_URL) {
      console.error(pc.red("DEN_URL is required in local mode"));
      process.exit(1);
    }
  } else {
    if (!config.e2bApiKey) {
      console.error(pc.red("E2B_API_KEY is required"));
      process.exit(1);
    }
  }
  if (!config.githubToken) {
    console.error(pc.red("GITHUB_TOKEN is required"));
    process.exit(1);
  }

  const workDir = isLocal ? "/home/sandbox" : "/home/user";
  // For local base, lean on the pre-installed Node in the node:22-slim image.
  const isLocalBase = isLocal && isBaseTemplate;
  const nodeDir = isLocalBase ? "/usr/local" : `${workDir}/.node`;
  const nodeBinPath = `${nodeDir}/bin`;
  const remotePath = `${workDir}/run-task.cjs`;

  const publisher = createStreamPublisher({
    upstashRedisRestUrl: config.upstashRedisRestUrl || process.env.UPSTASH_REDIS_REST_URL,
    upstashRedisToken: config.upstashRedisToken || process.env.UPSTASH_REDIS_TOKEN,
    taskId,
  });

  const bundlePath = resolve(process.cwd(), "dist/run-task.cjs");
  const bundle = readFileSync(bundlePath, "utf8");

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
    TARGET_DIR: `${workDir}/target`,
    WORK_DIR: workDir,
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
    PW_EXECUTABLE_PATH: isLocal ? "/usr/bin/chromium" : "/usr/bin/chromium",
    PLAYWRIGHT_BROWSERS_PATH: "0",
    UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || "",
    UPSTASH_REDIS_TOKEN: config.upstashRedisToken || "",
    LANGFUSE_PUBLIC_KEY: config.langfusePublicKey || "",
    LANGFUSE_SECRET_KEY: config.langfuseSecretKey || "",
    LANGFUSE_BASE_URL: config.langfuseBaseUrl || "",
    SUPABASE_URL: config.supabaseUrl || "",
    SUPABASE_SERVICE_KEY: config.supabaseServiceKey || "",
    MAX_TURNS: process.env.MAX_TURNS ?? String(config.maxTurns),
    MAX_WALL_CLOCK_MINUTES: process.env.MAX_WALL_CLOCK_MINUTES ?? String(config.maxWallClockMinutes),
    MAX_COST_USD: process.env.MAX_COST_USD ?? String(config.maxCostUsd),
    DAYBREAK_CHECKPOINT_INTERVAL: config.checkpointInterval || "tool",
    DAYBREAK_SESSION_STORE_BACKEND: config.sessionStoreBackend || "supabase",
    DAYBREAK_FORK_STRATEGY: config.forkStrategy || "auto",
    DAYBREAK_MAX_CHECKPOINTS_PER_TASK: String(config.maxCheckpointsPerTask ?? 100),
    REQUIRE_APPROVAL_FOR_DESTRUCTIVE: "false",
    DENYLIST_PATTERNS: config.denylistPatterns.join(","),
    COMPACTION_ENABLED: String(config.compactionEnabled),
    COMPACTION_RESERVE_TOKENS: String(config.compactionReserveTokens),
    COMPACTION_KEEP_RECENT_TOKENS: String(config.compactionKeepRecentTokens),
    DAYBREAK_MODE: config.mode,
    DEN_URL: config.denUrl || "",
    DEN_API_KEY: config.denApiKey || "",
    PHOENIX_URL: config.phoenixUrl || "",
    PHOENIX_PROJECT: config.phoenixProject || "default",
    PHOENIX_API_KEY: config.phoenixApiKey || "",
  };

  if (isLocal) {
    sandboxEnvs.SUPABASE_URL = process.env.SANDBOX_SUPABASE_URL || "http://kong:8000";
    sandboxEnvs.UPSTASH_REDIS_REST_URL = process.env.SANDBOX_UPSTASH_REDIS_REST_URL || "http://up-redis:8080";
    sandboxEnvs.PHOENIX_URL = process.env.SANDBOX_PHOENIX_URL || "http://phoenix:6006";
  }

  let sandbox: SandboxAdapter;
  try {
    sandbox = isLocal
      ? await getDenSandbox(config, workDir, sandboxEnvs, publisher, connectId, e2bSnapshotId, denImage)
      : await getE2BSandbox(config, sandboxEnvs, publisher, connectId, e2bSnapshotId);
  } catch (error) {
    console.error(pc.red("[sandbox] failed to get sandbox:"), error);
    publisher.publish("sandbox_error", { error: String(error), taskId });
    process.exit(1);
  }

  try {
    if (isBaseTemplate && !connectId) {
      if (isLocalBase) {
        console.log(pc.bold("[sandbox] using local Node base image; skipping Node/Chromium install"));
      } else {
        console.log(pc.bold("[sandbox] installing Node 22..."));
        const setup = await sandbox.run(
          `mkdir -p ${nodeDir} && curl -fsSL ${NODE22_URL} | tar -xJf - -C ${nodeDir} --strip-components=1 && ${nodeDir}/bin/node --version`,
          { timeoutMs: SETUP_TIMEOUT_MS },
        );
        if (setup.exitCode !== 0) {
          throw new Error(`Node 22 install failed:\n${setup.stdout}\n${setup.stderr}`);
        }
        process.stdout.write(setup.stdout.trim() + "\n");

        console.log(pc.bold("[sandbox] installing Chromium (browser tool)..."));
        const browserSetup = await sandbox.run(
          "apt-get update -qq && apt-get install -y -qq chromium chromium-driver 2>&1 | tail -n 50",
          { timeoutMs: BROWSER_INSTALL_TIMEOUT_MS, user: "root" },
        );
        if (browserSetup.exitCode !== 0) {
          throw new Error(`Chromium install failed:\n${browserSetup.stdout}\n${browserSetup.stderr}`);
        }
        process.stdout.write(browserSetup.stdout.trim() + "\n");
      }

      console.log(pc.bold("[sandbox] installing Playwright core..."));
      const pwSetup = await sandbox.run(
        `cd ${workDir} && npm_config_cache=${workDir}/.npm npm_config_loglevel=error npm_config_audit=false npm_config_fund=false ${nodeDir}/bin/npm install playwright-core 2>&1 | tail -n 30`,
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
      await sandbox.run(`pkill -f run-task.cjs || true`, { timeoutMs: 30_000 });
    }

    console.log(pc.bold("[sandbox] uploading agent bundle..."));
    await sandbox.writeFile(remotePath, bundle);

    if (isHeal) {
      console.log(pc.bold("[sandbox] running heal agent in sandbox..."));
      publisher.publish("heal_task_start", { sandboxId: sandbox.id, taskId, repo: targetRepo, branch: targetBranch, prBranch });
    } else if (isReview) {
      console.log(pc.bold("[sandbox] running review agent in sandbox..."));
      publisher.publish("review_task_start", { sandboxId: sandbox.id, taskId, repo: targetRepo, branch: targetBranch, prBranch });
    } else {
      console.log(pc.bold("[sandbox] running agent in sandbox..."));
    }

    const result = await sandbox.run(`${nodeBinPath}/node ${remotePath}`, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      env: sandboxEnvs,
      background: true,
      onStdout: (data: string) => {
        process.stdout.write(data);
      },
      onStderr: (data: string) => {
        process.stderr.write(data);
      },
    });

    process.exitCode = result.exitCode;
    console.log(pc.bold("\n[sandbox] exit:"), result.exitCode);

    if (keepAlive) {
      try {
        await sandbox.setTimeout(keepAliveMs);
        const keepAliveUntil = Date.now() + keepAliveMs;
        console.log(pc.bold(`[sandbox] keeping sandbox alive until ${new Date(keepAliveUntil).toISOString()}`));
        publisher.publish("sandbox_keep_alive", { sandboxId: sandbox.id, taskId, keepAliveMs, keepAliveUntil });
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
    } else if (typeof (error as { exitCode?: number }).exitCode === "number") {
      process.exitCode = (error as { exitCode: number }).exitCode;
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
