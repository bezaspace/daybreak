import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@daybreak/shared";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelRuntime } from "../llm.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(SCRIPT_PATH, "../../../../");

interface SpawnArgs {
  sessionFile: string;
  sessionDir: string;
  targetDir: string;
  targetId: string;
  prompt: string;
}

function parseArgs(): { child: boolean } & Partial<SpawnArgs> {
  const args = process.argv.slice(2);
  const child = args.includes("--child");
  const pick = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  return {
    child,
    sessionFile: pick("--session-file"),
    sessionDir: pick("--session-dir"),
    targetDir: pick("--target-dir"),
    targetId: pick("--target-id"),
    prompt: pick("--prompt"),
  };
}

async function loadModel() {
  const config = loadConfig();
  return createModelRuntime(config.llm, config.llmFallback, {}, config.llmPricing);
}

function createSettingsManager() {
  return SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      defaultProjectTrust: "always",
    },
    { projectTrusted: true },
  );
}

async function createSession(cwd: string, sessionFile?: string, sessionDir?: string) {
  const config = loadConfig();
  const { modelRuntime, model } = await loadModel();
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, sessionDir, cwd)
    : SessionManager.create(cwd, join(cwd, ".daybreak", "session"));
  const { session } = await createAgentSession({
    modelRuntime,
    model,
    tools: ["read", "bash", "edit", "write"],
    sessionManager,
    settingsManager: createSettingsManager(),
    cwd,
  });
  session.agent.state.systemPrompt =
    "You are a helpful coding assistant. Use the provided tools. Prefer short, correct answers.";
  return { session, sessionManager, modelRuntime };
}

function findSessionFile(sessionManager: SessionManager) {
  return sessionManager.getSessionFile() ?? join(sessionManager.getSessionDir(), `${sessionManager.getSessionId()}.jsonl`);
}

function logStage(label: string, value?: unknown) {
  console.log(`[session-fork] ${label}${value !== undefined ? `: ${value}` : ""}`);
}

async function runParent() {
  const targetDir = mkdtempSync(join(tmpdir(), "daybreak-session-fork-"));
  writeFileSync(join(targetDir, "README.md"), "# initial\n");

  const { session, sessionManager } = await createSession(targetDir);
  const sessionFile = findSessionFile(sessionManager);
  const sessionDir = sessionManager.getSessionDir();

  logStage("working directory", targetDir);
  logStage("session file", sessionFile);

  await session.prompt("List all files in the current directory using bash and report the names.");
  const afterTurn1 = sessionManager.getLeafId();
  logStage("leaf after turn 1", afterTurn1);

  await session.prompt("Create a file named original.txt containing the text 'original branch'.");
  const afterTurn2 = sessionManager.getLeafId();
  logStage("leaf after turn 2", afterTurn2);

  const originalContent = readFileSync(join(targetDir, "original.txt"), "utf8").trim();
  if (originalContent !== "original branch") {
    throw new Error(`Original file content unexpected: ${originalContent}`);
  }

  const args: SpawnArgs = {
    sessionFile,
    sessionDir,
    targetDir,
    targetId: afterTurn2 ?? "",
    prompt: "Create a file named branched.txt containing the text 'branched'.",
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", SCRIPT_PATH, "--child", "--session-file", args.sessionFile, "--session-dir", args.sessionDir, "--target-dir", args.targetDir, "--target-id", args.targetId, "--prompt", args.prompt],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: process.env,
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with code ${code}`));
    });
  });

  const branchedExists = existsSync(join(targetDir, "branched.txt"));
  if (!branchedExists) {
    throw new Error("branched.txt was not created in the forked process");
  }
  const branchedContent = readFileSync(join(targetDir, "branched.txt"), "utf8").trim();
  if (branchedContent !== "branched") {
    throw new Error(`branched.txt content unexpected: ${branchedContent}`);
  }

  logStage("fork test passed", `targetDir=${targetDir}`);
}

async function runChild(args: SpawnArgs) {
  const { session, sessionManager } = await createSession(args.targetDir, args.sessionFile, args.sessionDir);
  const leafAtLoad = sessionManager.getLeafId();
  if (leafAtLoad !== args.targetId) {
    logStage("branching to target", args.targetId);
    sessionManager.branch(args.targetId);
    session.agent.state.messages = sessionManager.buildSessionContext().messages;
  } else {
    logStage("loaded at target leaf", leafAtLoad);
  }

  await session.prompt(args.prompt);
  logStage("child prompt completed");
}

async function main() {
  const args = parseArgs();
  if (args.child) {
    if (!args.sessionFile || !args.sessionDir || !args.targetDir || !args.targetId || !args.prompt) {
      console.error("Missing required child arguments");
      process.exit(1);
    }
    await runChild(args as SpawnArgs);
  } else {
    await runParent();
  }
}

main().catch((error) => {
  console.error("[session-fork] error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
