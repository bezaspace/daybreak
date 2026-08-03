#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { Redis } from "@upstash/redis";
import { TaskRunner, type TaskEvent } from "./session.js";
import { createStreamPublisher } from "./stream.js";
import { CheckpointStore } from "./checkpoint.js";
import { SessionStore } from "./session-store.js";
import type { Checkpoint } from "@daybreak/shared";

const workDir = process.env.WORK_DIR || "/tmp";
const targetRepoUrl = process.env.TARGET_REPO_URL;
const targetBranch = process.env.TARGET_BRANCH || "main";
const targetDir = process.env.TARGET_DIR || `${workDir}/target`;
const forkSourceBranch = process.env.FORK_SOURCE_BRANCH || targetBranch;
const taskId = process.env.TASK_ID || `task-${Date.now()}`;
const rewindToCheckpoint = process.env.REWIND_TO_CHECKPOINT;
const forkFromCheckpoint = process.env.FORK_FROM_CHECKPOINT;
const parentTaskId = process.env.PARENT_TASK_ID || taskId;
const prBranch = process.env.PR_BRANCH_NAME || `daybreak/${taskId}`;
const autoApprove = process.env.AUTO_APPROVE !== "false";
const planMode = process.env.PLAN_MODE === "true";
const pushAfterFix = process.env.PUSH_AFTER_FIX !== "false";
const isHeal = process.env.HEAL_MODE === "true";
const gitAskpassPath = process.env.GIT_ASKPASS || `${workDir}/.git-askpass.sh`;

const approvalRedis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_TOKEN })
    : undefined;

function getDefaultPrompt(): string {
  const pushInstructions = pushAfterFix
    ? ` You are already on branch "${prBranch}". After the test passes, stage the change with "git add -A", commit with "git commit -m 'fix: <concise message>'", and push to origin with "git push -u origin ${prBranch}". Do not push to ${targetBranch} directly.`
    : "";
  return `You are in a git repository at ${targetDir}. There is a failing test. Read the source and test files, understand the bug, make the minimal fix, and run the test command until it passes.${pushInstructions}`;
}

const prompt = process.env.FORK_PROMPT || process.env.TASK_PROMPT || getDefaultPrompt();
const systemPrompt = process.env.TASK_SYSTEM_PROMPT || `You are Daybreak, an autonomous coding agent running in an E2B sandbox. You have read, bash, edit, write, and browser tools. Investigate, fix, verify, then${pushAfterFix ? " commit and push to a feature branch" : " report the fix"}. Use the browser tool to visually verify web apps when relevant.`;

function writeGitAskpassScript(path: string) {
  const script = `#!/bin/bash
if [[ "$1" == *"Username"* ]]; then
  echo "x-access-token"
else
  echo "$GITHUB_TOKEN"
fi`;
  writeFileSync(path, script, { mode: 0o700 });
}

function run(cmd: string, cwd: string, stdio: "inherit" | "pipe" = "pipe", env?: NodeJS.ProcessEnv) {
  return execSync(cmd, { cwd, stdio, maxBuffer: 10 * 1024 * 1024, shell: "/usr/bin/bash", env });
}

function omitScreenshot<T>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  if (clone.details && typeof clone.details === "object") {
    const details = { ...(clone.details as Record<string, unknown>) };
    delete details.screenshotBase64;
    clone.details = details;
  }
  return clone as T;
}

function installDependencies(cwd: string) {
  const has = (name: string) => existsSync(join(cwd, name));
  if (has("pnpm-lock.yaml")) {
    run("pnpm install --frozen-lockfile", cwd, "inherit");
  } else if (has("package-lock.json")) {
    run("npm ci", cwd, "inherit");
  } else if (has("yarn.lock")) {
    run("yarn install --frozen-lockfile", cwd, "inherit");
  } else if (has("requirements.txt")) {
    run("pip install -r requirements.txt", cwd, "inherit");
  } else if (has("pyproject.toml")) {
    run("pip install -e .", cwd, "inherit");
  } else {
    console.log(pc.yellow("[run-task] no known lockfile found; skipping dependency install"));
  }
}

function toStreamData(event: TaskEvent): unknown {
  switch (event.type) {
    case "user_message":
      return { content: event.content, role: event.role };
    case "message_update":
      return {
        kind: event.assistantMessageEvent.type,
        delta: (event.assistantMessageEvent as { delta?: string }).delta,
      };
    case "message_end":
      return { role: event.message.role };
    case "tool_execution_start":
      return { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_end":
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        result: event.toolName === "browser" ? omitScreenshot(event.result) : event.result,
      };
    case "tool_execution_update":
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.toolName === "browser" ? omitScreenshot(event.partialResult) : event.partialResult,
      };
    case "auto_retry_start":
      return { attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage };
    case "auto_retry_end":
      return { attempt: event.attempt, success: event.success, finalError: event.finalError };
    case "agent_end":
      return { willRetry: event.willRetry };
    case "bash_execution_update":
      return { id: event.id, delta: event.delta };
    case "compaction_start":
      return { reason: event.reason };
    case "compaction_end":
      return {
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        tokensBefore: event.result?.tokensBefore,
        firstKeptEntryId: event.result?.firstKeptEntryId,
      };
    case "provider_switched":
    case "fallback_applied":
      return { from: event.from, to: event.to, reason: event.reason, modelId: event.modelId };
    case "circuit_breaker_triggered":
      return { reason: event.reason, limit: event.limit, current: event.current };
    case "cost_alert":
      return { threshold: event.threshold, limit: event.limit, current: event.current };
    case "file_too_large":
      return { path: event.path, size: event.size, maxBytes: event.maxBytes, maxLines: event.maxLines, reason: event.reason };
    case "compaction_advised":
      return { tokens: event.tokens, contextWindow: event.contextWindow, reserveTokens: event.reserveTokens };
    case "checkpoint_created": {
      const cp = event.checkpoint;
      return {
        turn: cp.turn,
        gitCommit: cp.gitCommit,
        sessionRef: cp.sessionRef,
        checkpointId: cp.id,
        costUsd: cp.costUsd,
      };
    }
    case "checkpoint_restored": {
      const cp = event.checkpoint;
      return { checkpointId: cp.id, turn: cp.turn, gitCommit: cp.gitCommit, sessionRef: cp.sessionRef };
    }
    case "task_rewind":
      return { checkpointId: event.checkpointId, prompt: event.prompt };
    case "branch_forked":
      return { checkpointId: event.checkpointId, prompt: event.prompt, parentTaskId: event.parentTaskId };
    case "approval_request":
      return { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, reason: event.reason, kind: event.kind };
    case "approval_resolved":
      return { toolCallId: event.toolCallId, decision: event.decision };
    default:
      return {};
  }
}

interface UserMessageQueueItem {
  content: string;
  method?: "sendUserMessage" | "steer" | "followUp";
  deliverAs?: "steer" | "followUp";
}

function createMessageConsumer(taskId: string, runner: TaskRunner, publisher: ReturnType<typeof createStreamPublisher>) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) {
    return { start: () => Promise.resolve(), stop: () => {} };
  }

  const redis = new Redis({ url, token });
  const key = `daybreak:messages:${taskId}`;
  let running = false;
  let stopped = false;

  async function poll() {
    while (running && !stopped) {
      const item = await redis.lpop(key);
      if (item && typeof item === "string") {
        try {
          const parsed = JSON.parse(item) as UserMessageQueueItem;
          const content = parsed.content;
          const method = parsed.method || "sendUserMessage";
          console.log(pc.cyan(`[message] ${method}: ${content.slice(0, 80)}`));
          if (method === "steer") {
            await runner.steer(content);
          } else if (method === "followUp") {
            await runner.followUp(content);
          } else if (parsed.deliverAs) {
            await runner.sendUserMessage(content, { deliverAs: parsed.deliverAs });
          } else {
            await runner.sendUserMessage(content, { deliverAs: "followUp" });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(pc.red("[message] failed to deliver user message:"), message);
          publisher.publish("task_failed", { error: `user message delivery failed: ${message}` });
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  return {
    start: () => {
      running = true;
      stopped = false;
      return poll();
    },
    stop: () => {
      stopped = true;
      running = false;
    },
  };
}

async function main() {
  if (!targetRepoUrl) {
    console.error(pc.red("TARGET_REPO_URL is required"));
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const cloneDepth = config.maxRepoCloneDepth;
  const depthFlag = cloneDepth > 0 ? ` --depth ${cloneDepth}` : "";

  const publisher = createStreamPublisher({
    upstashRedisRestUrl: config.upstashRedisRestUrl,
    upstashRedisToken: config.upstashRedisToken,
  });

  publisher.publish("task_start", { repo: targetRepoUrl, branch: targetBranch, prBranch, workDir });

  if (process.env.GITHUB_TOKEN) {
    writeGitAskpassScript(gitAskpassPath);
    process.env.GIT_ASKPASS = gitAskpassPath;
  }

  let checkpoint: Checkpoint | undefined;
  const checkpointId = rewindToCheckpoint || forkFromCheckpoint;

  if (checkpointId) {
    console.log(pc.bold(`[run-task] ${forkFromCheckpoint ? "forking" : "restoring"} checkpoint ${checkpointId}...`));
    const cpSessionStore = new SessionStore({
      taskId: parentTaskId,
      cwd: targetDir,
      supabaseUrl: config.supabaseUrl,
      supabaseServiceKey: config.supabaseServiceKey,
    });
    const cpStore = new CheckpointStore({
      taskId: parentTaskId,
      cwd: targetDir,
      sessionStore: cpSessionStore,
      supabaseUrl: config.supabaseUrl,
      supabaseServiceKey: config.supabaseServiceKey,
    });
    const found = await cpStore.getCheckpoint(checkpointId);
    if (!found || !found.gitCommit) {
      throw new Error(`Checkpoint ${checkpointId} not found or has no git commit`);
    }
    checkpoint = found;

    if (!existsSync(`${targetDir}/.git`)) {
      if (!targetRepoUrl) {
        throw new Error(`Repository at ${targetDir} not found and TARGET_REPO_URL is not set; cannot ${forkFromCheckpoint ? "fork" : "rewind"}`);
      }
      const cloneBranch = forkFromCheckpoint ? forkSourceBranch : targetBranch;
      run(`rm -rf "${targetDir}" && git clone --branch ${cloneBranch} --single-branch${depthFlag} ${targetRepoUrl} "${targetDir}"`, workDir, "inherit");
      run(`git config user.name "Daybreak Bot" && git config user.email "daybreak@example.com"`, targetDir, "inherit");
    }
    run(
      `git config user.name "Daybreak Bot" && git config user.email "daybreak@example.com" && git reset --hard && git checkout -B ${prBranch} ${checkpoint.gitCommit} && git reset --hard && git clean -fd`,
      targetDir,
      "inherit",
    );

    if (forkFromCheckpoint) {
      console.log(pc.bold("[run-task] installing dependencies for fork..."));
      installDependencies(targetDir);
    }
  } else {
    console.log(pc.bold("[run-task] cloning target repo..."));
    if (process.env.REVIEW_MODE === "true" || process.env.HEAL_MODE === "true") {
      if (existsSync(`${targetDir}/.git`)) {
        console.log(pc.bold(isHeal ? "[run-task] using existing repo for heal..." : "[run-task] using existing repo for review..."));
        run(
          `git config user.name "Daybreak Bot" && git config user.email "daybreak@example.com" && git fetch origin && git checkout ${prBranch} && git pull origin ${prBranch}`,
          targetDir,
          "inherit",
        );
      } else {
        run(`git clone --branch ${prBranch} --single-branch${depthFlag} ${targetRepoUrl} "${targetDir}"`, workDir, "inherit");
        run(
          `git config user.name "Daybreak Bot" && git config user.email "daybreak@example.com"`,
          targetDir,
          "inherit",
        );
      }
    } else {
      run(`rm -rf "${targetDir}" && git clone --branch ${targetBranch} --single-branch${depthFlag} ${targetRepoUrl} "${targetDir}"`, workDir, "inherit");

      // Create the feature branch and set git identity so the agent cannot
      // accidentally push to the protected target branch.
      run(
        `git config user.name "Daybreak Bot" && git config user.email "daybreak@example.com" && git checkout -b ${prBranch}`,
        targetDir,
        "inherit",
      );
    }
  }

  console.log(pc.bold("[run-task] config:"), {
    protectedBranches: config.protectedBranches,
    denylistPatterns: config.denylistPatterns,
    maxTurns: config.maxTurns,
    maxCostUsd: config.maxCostUsd,
    prBranch,
    targetBranch,
  });

  const runner = new TaskRunner(config);
  let consumer: ReturnType<typeof createMessageConsumer> | undefined;
  let consumerPromise: Promise<void> = Promise.resolve();

  try {
    const compactionReserveTokens = process.env.COMPACTION_RESERVE_TOKENS ? Number.parseInt(process.env.COMPACTION_RESERVE_TOKENS, 10) : undefined;
    const compactionKeepRecentTokens = process.env.COMPACTION_KEEP_RECENT_TOKENS ? Number.parseInt(process.env.COMPACTION_KEEP_RECENT_TOKENS, 10) : undefined;

    const result = await runner.run({
      prompt,
      cwd: targetDir,
      systemPrompt,
      autoApprove,
      planMode,
      approvalRedis,
      taskId,
      checkpoint,
      isFork: Boolean(forkFromCheckpoint),
      compactionReserveTokens,
      compactionKeepRecentTokens,
      onSessionReady: () => {
        consumer = createMessageConsumer(taskId, runner, publisher);
        consumerPromise = consumer.start();
      },
      onEvent: (event) => {
        publisher.publish(event.type, toStreamData(event));
        if (event.type === "tool_execution_update" && event.toolName === "browser") {
          const partial = event.partialResult as { details?: { screenshotBase64?: string; url?: string; mimeType?: string } } | undefined;
          if (partial?.details?.screenshotBase64) {
            publisher.publish("browser_screenshot", {
              url: partial.details.url,
              screenshot: partial.details.screenshotBase64,
              mimeType: partial.details.mimeType || "image/png",
            });
          }
        }
      },
    });

    console.log(pc.bold("\n=== Task result ==="));
    console.log("Success:", result.success);
    console.log("Summary:", result.summary);
    console.log("Metrics:", JSON.stringify(result.metrics, null, 2));
    if (result.error) console.log(pc.red("Error:"), result.error);

    publisher.publish(result.success ? "task_complete" : "task_failed", {
      success: result.success,
      summary: result.summary,
      metrics: result.metrics,
      error: result.error,
      traceId: result.traceId,
      provider: result.provider,
    });

    if (result.success && pushAfterFix) {
      try {
        const currentBranch = run(`cd "${targetDir}" && git branch --show-current`, ".", "pipe").toString().trim();
        if (currentBranch && currentBranch !== prBranch) {
          console.log(pc.bold(`[run-task] renaming current branch ${currentBranch} -> ${prBranch}`));
          run(`cd "${targetDir}" && git branch -m ${prBranch}`, ".", "inherit");
        }
        console.log(pc.bold(`[run-task] pushing ${prBranch} to origin`));
        run(`cd "${targetDir}" && git push -u origin ${prBranch}`, ".", "inherit");
        publisher.publish("commit_pushed", { prBranch });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red("[run-task] push failed:"), message);
        publisher.publish("task_failed", { error: message });
        process.exitCode = 1;
      }
    }

    if (isHeal) {
      publisher.publish(result.success ? "heal_complete" : "heal_failed", {
        success: result.success,
        summary: result.summary,
        error: result.error,
      });
    } else if (process.env.REVIEW_MODE === "true") {
      publisher.publish(result.success ? "review_complete" : "review_failed", {
        success: result.success,
        summary: result.summary,
        error: result.error,
      });
    }

    process.exitCode = process.exitCode ?? (result.success ? 0 : 1);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(pc.red("[run-task] error:"), errorMessage);
    publisher.publish("task_failed", { error: errorMessage, traceId: runner.getTraceId() });
    process.exitCode = 1;
  } finally {
    consumer?.stop();
    await consumerPromise;
    await runner.shutdown();
    await publisher.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
