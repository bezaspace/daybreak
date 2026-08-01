#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { TaskRunner } from "./session.js";

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const fixtureArg = process.argv.find((arg) => arg.startsWith("--fixture="));
const fixture = resolve(__dirname, fixtureArg ? fixtureArg.split("=")[1] : "../../evals/fixtures/failing-sum");

const prompt = `You are in the directory ${fixture}. There is a failing test. Read the source and test files, understand the bug, fix it, and run the test command until it passes. Do not create a git branch or push anything. Keep changes minimal.`;

async function main() {
  const config = loadConfig(resolve(__dirname, "../../.env"));
  const runner = new TaskRunner(config);

  const result = await runner.run({
    prompt,
    cwd: fixture,
    systemPrompt:
      "You are Daybreak, an autonomous coding agent. Use the available tools to investigate and fix the repository. Be concise. Report the final fix.",
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
