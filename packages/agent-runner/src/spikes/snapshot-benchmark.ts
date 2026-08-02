import { loadConfig } from "@daybreak/shared";
import { Sandbox } from "e2b";
import { randomUUID } from "node:crypto";

const NODE22_URL = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz";
const WORK_DIR = "/home/user";
const NODE_DIR = `${WORK_DIR}/.node`;
const TARGET_REPO = "https://github.com/bezaspace/daybreak-target";
const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;

function now() {
  return Date.now();
}

async function main() {
  const config = loadConfig();
  if (!config.e2bApiKey) {
    console.error("E2B_API_KEY is required");
    process.exit(1);
  }

  const timings: Record<string, number> = {};
  const started = now();

  console.log("[snapshot-benchmark] creating sandbox...");
  const sandbox = await Sandbox.create({
    template: config.e2bTemplate || "base",
    allowInternetAccess: true,
    timeoutMs: 30 * 60 * 1000,
    apiKey: config.e2bApiKey,
    validateApiKey: false,
  });
  const sandboxCreated = now();
  timings.sandboxCreateMs = sandboxCreated - started;
  console.log(`[snapshot-benchmark] sandbox created: ${sandbox.sandboxId} (${timings.sandboxCreateMs}ms)`);

  if ((config.e2bTemplate || "base") === "base") {
    console.log("[snapshot-benchmark] installing Node 22...");
    const nodeSetupStart = now();
    await sandbox.commands.run(
      `mkdir -p ${NODE_DIR} && curl -fsSL ${NODE22_URL} | tar -xJf - -C ${NODE_DIR} --strip-components=1 && ${NODE_DIR}/bin/node --version`,
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
    timings.nodeInstallMs = now() - nodeSetupStart;
    console.log(`[snapshot-benchmark] Node installed (${timings.nodeInstallMs}ms)`);
  }

  const nodeBin = `${NODE_DIR}/bin`;
  const targetDir = `${WORK_DIR}/target`;

  console.log(`[snapshot-benchmark] cloning ${TARGET_REPO}...`);
  const cloneStart = now();
  await sandbox.commands.run(
    `rm -rf "${targetDir}" && git clone ${TARGET_REPO} "${targetDir}"`,
    { timeoutMs: 120_000, envs: { PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin` } },
  );
  timings.cloneMs = now() - cloneStart;
  console.log(`[snapshot-benchmark] cloned (${timings.cloneMs}ms)`);

  console.log("[snapshot-benchmark] running test suite...");
  const testStart = now();
  const testResult = await sandbox.commands.run(
    `cd "${targetDir}" && ( [ -f package-lock.json ] && npm ci || [ -f pnpm-lock.yaml ] && pnpm install --frozen-lockfile || [ -f yarn.lock ] && yarn install --frozen-lockfile ) && npm test`,
    { timeoutMs: TEST_TIMEOUT_MS, envs: { PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin` } },
  );
  timings.testRunMs = now() - testStart;
  console.log(`[snapshot-benchmark] test exit=${testResult.exitCode} (${timings.testRunMs}ms)`);

  console.log("[snapshot-benchmark] creating snapshot...");
  const snapshotStart = now();
  const snapshot = await sandbox.createSnapshot();
  timings.snapshotCreateMs = now() - snapshotStart;
  console.log(`[snapshot-benchmark] snapshot created: ${snapshot.snapshotId} (${timings.snapshotCreateMs}ms)`);

  console.log("[snapshot-benchmark] spawning new sandbox from snapshot...");
  const spawnStart = now();
  const forked = await Sandbox.create({
    template: snapshot.snapshotId,
    allowInternetAccess: true,
    timeoutMs: 30 * 60 * 1000,
    apiKey: config.e2bApiKey,
    validateApiKey: false,
  });
  timings.forkSpawnMs = now() - spawnStart;
  console.log(`[snapshot-benchmark] forked sandbox: ${forked.sandboxId} (${timings.forkSpawnMs}ms)`);

  console.log("[snapshot-benchmark] verifying test passes in fork...");
  const verifyStart = now();
  const verifyResult = await forked.commands.run(
    `cd "${targetDir}" && npm test`,
    { timeoutMs: TEST_TIMEOUT_MS, envs: { PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin` } },
  );
  timings.forkVerifyMs = now() - verifyStart;
  console.log(`[snapshot-benchmark] fork test exit=${verifyResult.exitCode} (${timings.forkVerifyMs}ms)`);

  const totalMs = now() - started;

  const result = {
    sandboxId: sandbox.sandboxId,
    snapshotId: snapshot.snapshotId,
    forkedSandboxId: forked.sandboxId,
    timings,
    totalMs,
    note: "Credit impact is not directly exposed by the E2B SDK; estimate via runtime seconds + snapshot storage. See docs/COST_BUDGET.md.",
  };

  console.log("\n[snapshot-benchmark] result:");
  console.log(JSON.stringify(result, null, 2));

  try {
    await forked.kill();
  } catch {
    // ignore
  }
  try {
    await sandbox.kill();
  } catch {
    // ignore
  }
}

main().catch((error) => {
  console.error("[snapshot-benchmark] error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
