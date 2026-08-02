#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { TaskRunner, CheckpointStore, SessionStore } from "@daybreak/agent-runner";
import pc from "picocolors";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface TraceInfo {
  id: string;
  name?: string;
  timestamp?: string;
  observations?: unknown[];
}

function langfuseAuthHeader(publicKey?: string, secretKey?: string): string | undefined {
  if (!publicKey || !secretKey) return undefined;
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

async function verifyTrace(config: ReturnType<typeof loadConfig>, traceId?: string): Promise<TraceInfo | undefined> {
  if (!traceId) return undefined;
  const baseUrl = config.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
  const publicKey = config.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY;
  const auth = langfuseAuthHeader(publicKey, secretKey);
  if (!auth) return undefined;
  const res = await fetch(`${baseUrl}/api/public/traces/${traceId}`, { headers: { Authorization: auth } });
  if (!res.ok) return undefined;
  return (await res.json()) as TraceInfo;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");

interface EvalCase {
  name: string;
  fixture: string;
  prompt: string;
}

async function loadFixtures(): Promise<EvalCase[]> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      fixture: join(fixturesDir, entry.name),
      prompt: `Fix the failing test in this repository. Read the source and test files, understand the bug, make the minimal fix, and run the test command until it passes. Do not push.`,
    }));
}

async function main() {
  const envPath = resolve(__dirname, "../../.env");
  const config = loadConfig(envPath);
  const fixtures = await loadFixtures();

  if (fixtures.length === 0) {
    console.log(pc.yellow("No fixtures found. Add one to fixtures/ and rerun."));
    process.exit(0);
  }

  console.log(pc.bold(`Running ${fixtures.length} eval case(s)...\n`));
  let passed = 0;
  let failed = 0;

  for (const evalCase of fixtures) {
    console.log(pc.bold(`--- ${evalCase.name} ---`));
    const runner = new TaskRunner(config);
    const taskId = `eval-${evalCase.name}`;

    try {
      await rm(join(evalCase.fixture, ".daybreak"), { recursive: true, force: true }).catch(() => {});
      const result = await runner.run({
        taskId,
        prompt: evalCase.prompt,
        cwd: evalCase.fixture,
        autoApprove: true,
        systemPrompt:
          "You are Daybreak, an autonomous coding agent. Investigate, fix, and verify the repository with minimal changes.",
      });

      console.log("Success:", result.success);
      console.log("Trace ID:", result.traceId);
      console.log("Provider:", result.provider ?? "-");
      console.log("Cost USD:", result.metrics.estimatedCostUsd ?? "-");
      console.log("Metrics:", JSON.stringify(result.metrics, null, 2));
      if (result.error) console.log(pc.red("Error:"), result.error);

      if (result.success) {
        if (!result.traceId) {
          console.log(pc.red("FAIL: completed task has no traceId"));
          failed++;
          continue;
        }
        if (typeof result.metrics.estimatedCostUsd !== "number" || result.metrics.estimatedCostUsd < 0) {
          console.log(pc.red("FAIL: estimatedCostUsd is missing or negative"));
          failed++;
          continue;
        }
        if (result.metrics.estimatedCostUsd > config.maxCostUsd) {
          console.log(pc.red(`FAIL: cost $${result.metrics.estimatedCostUsd} exceeds MAX_COST_USD $${config.maxCostUsd}`));
          failed++;
          continue;
        }
        const trace = await verifyTrace(config, result.traceId);
        if (trace) {
          const obsCount = trace.observations?.length ?? 0;
          console.log(pc.green(`Trace verified: ${obsCount} observation(s)`));
        } else if (config.langfusePublicKey && config.langfuseSecretKey) {
          console.log(pc.yellow("Could not verify trace in Langfuse (may still be processing)"));
        }

        // Verify time-travel checkpoint artifacts.
        const sessionStore = new SessionStore({ taskId, cwd: evalCase.fixture });
        const checkpointStore = new CheckpointStore({ taskId, cwd: evalCase.fixture, sessionStore });
        const checkpoints = await checkpointStore.listCheckpoints(taskId);
        if (checkpoints.length === 0) {
          console.log(pc.red("FAIL: no checkpoints found"));
          failed++;
          continue;
        }
        const last = checkpoints[checkpoints.length - 1];
        if (!last.gitCommit || !last.sessionRef) {
          console.log(pc.red(`FAIL: last checkpoint missing gitCommit or sessionRef: ${last.id}`));
          failed++;
          continue;
        }
        if (typeof last.costUsd !== "number") {
          console.log(pc.red(`FAIL: last checkpoint has no costUsd: ${last.id}`));
          failed++;
          continue;
        }
        console.log(pc.green(`Checkpoints verified: ${checkpoints.length} checkpoint(s), last=${last.gitCommit.slice(0, 7)}`));

        passed++;
      } else {
        failed++;
      }
      console.log();
    } finally {
      await runner.shutdown();
    }
  }

  console.log(pc.bold("=== Eval summary ==="));
  console.log(pc.green(`Passed: ${passed}`));
  console.log(pc.red(`Failed: ${failed}`));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
