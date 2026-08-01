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
const SETUP_TIMEOUT_MS = 180_000;
const BROWSER_INSTALL_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const templateName = getArg("--template") || config.e2bTemplate || "base";
  const isBaseTemplate = templateName === "base";
  const targetRepo = getArg("--repo") || "https://github.com/bezaspace/daybreak-target";
  const targetBranch = getArg("--branch") || "main";
  const taskId = getArg("--task-id") || randomUUID();
  const taskPrompt = getArg("--prompt");
  const pushAfterFix = getArg("--push") !== "false";

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

  const nodeBinPath = `${NODE_DIR}/bin`;

  console.log(pc.bold(`[sandbox] creating E2B sandbox from template ${templateName}...`));
  const sandbox = await Sandbox.create({
    template: templateName,
    allowInternetAccess: true,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey: config.e2bApiKey,
    validateApiKey: false,
    envs: {
      PATH: `${nodeBinPath}:/usr/local/bin:/usr/bin:/bin`,
      NODE_PATH: "/usr/local/lib/node_modules",
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
      PUSH_AFTER_FIX: String(pushAfterFix),
      PR_BRANCH_NAME: `daybreak/${taskId}`,
      TASK_PROMPT: taskPrompt || "",
      PW_EXECUTABLE_PATH: "/usr/bin/chromium",
      PLAYWRIGHT_BROWSERS_PATH: "0",
      UPSTASH_REDIS_REST_URL: config.upstashRedisRestUrl || "",
      UPSTASH_REDIS_TOKEN: config.upstashRedisToken || "",
      MAX_TURNS: String(config.maxTurns),
      MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
      MAX_COST_USD: String(config.maxCostUsd),
      REQUIRE_APPROVAL_FOR_DESTRUCTIVE: "false",
      DENYLIST_PATTERNS: config.denylistPatterns.join(","),
    },
  });

  console.log(pc.bold(`[sandbox] created ${sandbox.sandboxId} taskId=${taskId}`));

  try {
    if (isBaseTemplate) {
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
    } else {
      console.log(pc.bold(`[sandbox] using pre-built template ${templateName}; skipping Node/Chromium install`));
    }

    console.log(pc.bold("[sandbox] uploading agent bundle..."));
    await sandbox.files.write(REMOTE_PATH, bundle);

    console.log(pc.bold("[sandbox] running agent in sandbox..."));
    const handle = await sandbox.commands.run(`${nodeBinPath}/node ${REMOTE_PATH}`, {
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
