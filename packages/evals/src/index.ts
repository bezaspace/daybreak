#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { TaskRunner } from "@daybreak/agent-runner";
import pc from "picocolors";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

    try {
      const result = await runner.run({
        prompt: evalCase.prompt,
        cwd: evalCase.fixture,
        autoApprove: true,
        systemPrompt:
          "You are Daybreak, an autonomous coding agent. Investigate, fix, and verify the repository with minimal changes.",
      });

      console.log("Success:", result.success);
      console.log("Trace ID:", result.traceId);
      console.log("Metrics:", JSON.stringify(result.metrics, null, 2));
      if (result.error) console.log(pc.red("Error:"), result.error);
      console.log();

      if (result.success) passed++;
      else failed++;
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
