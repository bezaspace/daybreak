#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { CommandExitError, Sandbox } from "e2b";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";

function getArg(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
}

const NODE22_URL = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz";
const WORK_DIR = "/home/user";
const NODE_DIR = `${WORK_DIR}/.node`;
const REMOTE_PATH = `${WORK_DIR}/run-task.cjs`;
const SETUP_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const targetRepo = getArg("--repo") || "https://github.com/bezaspace/daybreak-target";
  const targetBranch = getArg("--branch") || "main";
  const taskId = getArg("--task-id") || randomUUID();

  if (!config.e2bApiKey) {
    console.error(pc.red("E2B_API_KEY is required"));
    process.exit(1);
  }
  if (!config.githubToken) {
    console.error(pc.red("GITHUB_TOKEN is required"));
    process.exit(1);
  }

  const bundlePath = resolve(process.cwd(), "dist/run-task.cjs");
  const bundle = readFileSync(bundlePath, "utf8");

  console.log(pc.bold("[sandbox] creating E2B sandbox..."));
  const sandbox = await Sandbox.create({
    template: "base",
    allowInternetAccess: true,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey: config.e2bApiKey,
    validateApiKey: false,
    envs: {
      PATH: `${NODE_DIR}/bin:/usr/local/bin:/usr/bin:/bin`,
      LLM_PROVIDER: config.llm.provider,
      LLM_BASE_URL: config.llm.baseUrl,
      LLM_API_KEY: config.llm.apiKey,
      LLM_MODEL: config.llm.modelId,
      LLM_FALLBACK_PROVIDER: config.llmFallback?.provider || "",
      LLM_FALLBACK_BASE_URL: config.llmFallback?.baseUrl || "",
      LLM_FALLBACK_API_KEY: config.llmFallback?.apiKey || "",
      LLM_FALLBACK_MODEL: config.llmFallback?.modelId || "",
      GITHUB_TOKEN: config.githubToken,
      TASK_ID: taskId,
      TARGET_REPO_URL: targetRepo,
      TARGET_BRANCH: targetBranch,
      TARGET_DIR: `${WORK_DIR}/target`,
      WORK_DIR,
      AUTO_APPROVE: "true",
      PUSH_AFTER_FIX: "true",
      UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || "",
      UPSTASH_REDIS_TOKEN: config.upstashRedisToken || "",
      MAX_TURNS: String(config.maxTurns),
      MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
      MAX_COST_USD: String(config.maxCostUsd),
      REQUIRE_APPROVAL_FOR_DESTRUCTIVE: "false",
      PROTECTED_BRANCHES: "__none__",
      DENYLIST_PATTERNS: config.denylistPatterns.join(","),
    },
  });

  console.log(pc.bold(`[sandbox] created ${sandbox.sandboxId} taskId=${taskId}`));

  try {
    console.log(pc.bold("[sandbox] installing Node 22..."));
    const setup = await sandbox.commands.run(
      `mkdir -p ${NODE_DIR} && curl -fsSL ${NODE22_URL} | tar -xJf - -C ${NODE_DIR} --strip-components=1 && ${NODE_DIR}/bin/node --version`,
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (setup.exitCode !== 0) {
      throw new Error(`Node 22 install failed:\n${setup.stdout}\n${setup.stderr}`);
    }
    process.stdout.write(setup.stdout.trim() + "\n");

    console.log(pc.bold("[sandbox] uploading agent bundle..."));
    await sandbox.files.write(REMOTE_PATH, bundle);

    console.log(pc.bold("[sandbox] running agent in sandbox..."));
    const handle = await sandbox.commands.run(`${NODE_DIR}/bin/node ${REMOTE_PATH}`, {
      background: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
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
  } catch (error) {
    if (error instanceof CommandExitError) {
      process.exitCode = error.exitCode;
    } else {
      process.exitCode = 1;
    }
    console.error(pc.red("[sandbox] error:"), error);
  } finally {
    console.log(pc.bold("[sandbox] deleting sandbox..."));
    try {
      await sandbox.kill();
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
