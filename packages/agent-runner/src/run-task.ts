#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import pc from "picocolors";
import { TaskRunner } from "./session.js";
import { createStreamPublisher } from "./stream.js";

const workDir = process.env.WORK_DIR || "/tmp";
const targetRepoUrl = process.env.TARGET_REPO_URL;
const targetBranch = process.env.TARGET_BRANCH || "main";
const targetDir = process.env.TARGET_DIR || `${workDir}/target`;
const autoApprove = process.env.AUTO_APPROVE !== "false";
const pushAfterFix = process.env.PUSH_AFTER_FIX !== "false";
const gitAskpassPath = process.env.GIT_ASKPASS || `${workDir}/.git-askpass.sh`;

const defaultPrompt = `You are in a git repository at ${targetDir}. There is a failing test. Read the source and test files, understand the bug, make the minimal fix, and run the test command until it passes.${pushAfterFix ? ` Then stage the change with "git add -A", commit with "git -c user.name='Daybreak Bot' -c user.email='daybreak@example.com' commit -m 'fix: <concise message>'", and push to origin ${targetBranch}. Do not create any new branches.` : ""}`;

const prompt = process.env.TASK_PROMPT || defaultPrompt;
const systemPrompt = process.env.TASK_SYSTEM_PROMPT || `You are Daybreak, an autonomous coding agent running in an E2B sandbox. Investigate, fix, verify, then${pushAfterFix ? " commit and push" : " report the fix"}.`;

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

function toStreamData(event: AgentSessionEvent): unknown {
  switch (event.type) {
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
      return { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result };
    case "tool_execution_update":
      return { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult };
    case "auto_retry_start":
      return { attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage };
    case "auto_retry_end":
      return { attempt: event.attempt, success: event.success, finalError: event.finalError };
    case "agent_end":
      return { willRetry: event.willRetry };
    case "bash_execution_update":
      return { id: event.id, delta: event.delta };
    default:
      return {};
  }
}

async function main() {
  if (!targetRepoUrl) {
    console.error(pc.red("TARGET_REPO_URL is required"));
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const publisher = createStreamPublisher({
    upstashRedisRestUrl: config.upstashRedisRestUrl,
    upstashRedisToken: config.upstashRedisToken,
  });

  publisher.publish("task_start", { repo: targetRepoUrl, branch: targetBranch, workDir });

  if (process.env.GITHUB_TOKEN) {
    writeGitAskpassScript(gitAskpassPath);
    process.env.GIT_ASKPASS = gitAskpassPath;
  }

  console.log(pc.bold("[run-task] cloning target repo..."));
  run(`rm -rf "${targetDir}" && git clone --branch ${targetBranch} --single-branch ${targetRepoUrl} "${targetDir}"`, workDir, "inherit");

  const runner = new TaskRunner(config);

  try {
    const result = await runner.run({
      prompt,
      cwd: targetDir,
      systemPrompt,
      autoApprove,
      onEvent: (event) => publisher.publish(event.type, toStreamData(event)),
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
    });

    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(pc.red("[run-task] error:"), errorMessage);
    publisher.publish("task_failed", { error: errorMessage });
    process.exitCode = 1;
  } finally {
    await publisher.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
