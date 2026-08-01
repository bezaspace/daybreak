#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import pc from "picocolors";
import { fileURLToPath } from "node:url";
import { TaskRunner } from "./session.js";

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const targetRepoUrl = process.env.TARGET_REPO_URL;
const targetBranch = process.env.TARGET_BRANCH || "main";
const targetDir = process.env.TARGET_DIR || "/home/daytona/target";
const autoApprove = process.env.AUTO_APPROVE !== "false";
const pushAfterFix = process.env.PUSH_AFTER_FIX !== "false";

const defaultPrompt = `You are in a git repository at ${targetDir}. There is a failing test. Read the source and test files, understand the bug, make the minimal fix, and run the test command until it passes.${pushAfterFix ? ` Then stage the change with "git add -A", commit with "git -c user.name='Daybreak Bot' -c user.email='daybreak@example.com' commit -m 'fix: <concise message>'", and push to origin ${targetBranch}. Do not create any new branches.` : ""}`;

const prompt = process.env.TASK_PROMPT || defaultPrompt;
const systemPrompt = process.env.TASK_SYSTEM_PROMPT || `You are Daybreak, an autonomous coding agent running in a Daytona sandbox. Investigate, fix, verify, then${pushAfterFix ? " commit and push" : " report the fix"}.`;

function run(cmd: string, cwd: string, stdio: "inherit" | "pipe" = "pipe") {
  return execSync(cmd, { cwd, stdio, maxBuffer: 10 * 1024 * 1024 });
}

async function main() {
  if (!targetRepoUrl) {
    console.error(pc.red("TARGET_REPO_URL is required"));
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN;
  const cloneUrl = token ? targetRepoUrl.replace("https://", `https://x-access-token:${token}@`) : targetRepoUrl;

  console.log(pc.bold("[run-task] cloning target repo..."));
  run(`rm -rf "${targetDir}" && git clone --branch ${targetBranch} --single-branch ${cloneUrl} "${targetDir}"`, "/home/daytona", "inherit");

  const config = loadConfig();
  const runner = new TaskRunner(config);

  const result = await runner.run({
    prompt,
    cwd: targetDir,
    systemPrompt,
    autoApprove,
  });

  console.log(pc.bold("\n=== Task result ==="));
  console.log("Success:", result.success);
  console.log("Summary:", result.summary);
  console.log("Metrics:", JSON.stringify(result.metrics, null, 2));
  if (result.error) console.log(pc.red("Error:"), result.error);

  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
