#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { Daytona } from "@daytona/sdk";
import pc from "picocolors";

function getArg(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
}

async function main() {
  const config = loadConfig();
  const targetRepo = getArg("--repo") || "https://github.com/bezaspace/daybreak-target";
  const targetBranch = getArg("--branch") || "main";

  if (!config.daytonaApiKey || !config.daytonaApiUrl) {
    console.error(pc.red("DAYTONA_API_KEY and DAYTONA_API_URL are required"));
    process.exit(1);
  }
  if (!config.githubToken) {
    console.error(pc.red("GITHUB_TOKEN is required"));
    process.exit(1);
  }

  const daytona = new Daytona({
    apiKey: config.daytonaApiKey,
    apiUrl: config.daytonaApiUrl,
    target: config.daytonaTarget,
  });

  console.log(pc.bold("[sandbox] creating Daytona sandbox..."));
  const sandbox = await daytona.create({
    language: "typescript",
    autoStopInterval: 0,
    ttlMinutes: 120,
    envVars: {
      LLM_PROVIDER: config.llm.provider,
      LLM_BASE_URL: config.llm.baseUrl,
      LLM_API_KEY: config.llm.apiKey,
      LLM_MODEL: config.llm.modelId,
      LLM_FALLBACK_PROVIDER: config.llmFallback?.provider || "",
      LLM_FALLBACK_BASE_URL: config.llmFallback?.baseUrl || "",
      LLM_FALLBACK_API_KEY: config.llmFallback?.apiKey || "",
      LLM_FALLBACK_MODEL: config.llmFallback?.modelId || "",
      GITHUB_TOKEN: config.githubToken,
      TARGET_REPO_URL: targetRepo,
      TARGET_BRANCH: targetBranch,
      TARGET_DIR: "/home/daytona/target",
      AUTO_APPROVE: "true",
      PUSH_AFTER_FIX: "true",
      MAX_TURNS: String(config.maxTurns),
      MAX_WALL_CLOCK_MINUTES: String(config.maxWallClockMinutes),
      MAX_COST_USD: String(config.maxCostUsd),
      REQUIRE_APPROVAL_FOR_DESTRUCTIVE: "false",
      PROTECTED_BRANCHES: "__none__",
      DENYLIST_PATTERNS: config.denylistPatterns.join(","),
    },
  });

  console.log(pc.bold(`[sandbox] created ${sandbox.id} (${sandbox.state ?? "unknown state"})`));

  const sessionId = "daybreak-task";
  const setupAndRun = `set -e
cd /home/daytona
git clone https://x-access-token:$GITHUB_TOKEN@github.com/bezaspace/daybreak.git daybreak
cd daybreak
npx pnpm@11.18.0 install
npx pnpm@11.18.0 --filter agent-runner task`;

  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await sandbox.process.createSession(sessionId);
    console.log(pc.bold("[sandbox] running agent in sandbox (this may take a few minutes)..."));

    heartbeat = setInterval(() => process.stdout.write("."), 3000);

    const startResponse = await sandbox.process.executeSessionCommand(sessionId, { command: setupAndRun, runAsync: true }, 10);
    const cmdId = startResponse.cmdId;
    if (!cmdId) {
      throw new Error("No command ID returned for async session command");
    }

    let printedOutput = 0;
    let printedStderr = 0;
    let completed = false;

    while (!completed) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const [cmd, logs] = await Promise.all([
        sandbox.process.getSessionCommand(sessionId, cmdId),
        sandbox.process.getSessionCommandLogs(sessionId, cmdId),
      ]);

      if (logs.output && logs.output.length > printedOutput) {
        process.stdout.write(logs.output.slice(printedOutput));
        printedOutput = logs.output.length;
      }
      if (logs.stderr && logs.stderr.length > printedStderr) {
        process.stderr.write(logs.stderr.slice(printedStderr));
        printedStderr = logs.stderr.length;
      }

      if (typeof cmd.exitCode === "number") {
        completed = true;
        process.exitCode = cmd.exitCode;
        console.log(pc.bold("\n[sandbox] exit:"), cmd.exitCode);
      }
    }
  } catch (error) {
    console.error(pc.red("[sandbox] error:"), error);
    process.exitCode = 1;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    console.log(pc.bold("[sandbox] deleting sandbox..."));
    try {
      await sandbox.delete();
    } catch {
      // ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
