#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import pc from "picocolors";
import { createHmac, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

interface CiSelfHealOptions {
  controlPlaneUrl: string;
  repo: string;
  baseBranch: string;
  webhookSecret: string;
  githubToken: string;
  real: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  prNumber?: number;
  headBranch?: string;
  headSha?: string;
  checkRunId?: string;
  cleanup: boolean;
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseRepo(cloneUrl: string): { owner: string; name: string } | undefined {
  try {
    const url = new URL(cloneUrl);
    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return { owner: parts[0], name: parts[1] };
  } catch {
    return undefined;
  }
}

async function githubApi(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`GitHub API ${options.method || "GET"} ${path} failed: ${res.status} ${text}`);
  }
  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFailedCheckRun(repo: { owner: string; name: string }, headBranch: string, token: string, timeoutMs: number, pollIntervalMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await githubApi(`/repos/${repo.owner}/${repo.name}/commits/${headBranch}/check-runs`, token);
    const data = (await res.json()) as { check_runs: Array<{ id: number; name: string; head_sha: string; status: string; conclusion: string | null }> };
    const failed = data.check_runs.find((r) => r.status === "completed" && r.conclusion === "failure");
    if (failed) {
      return { checkRunId: failed.id, name: failed.name, headSha: failed.head_sha };
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`No failed check_run found on ${headBranch} within ${timeoutMs}ms`);
}

async function waitForCiPass(repo: { owner: string; name: string }, headBranch: string, token: string, timeoutMs: number, pollIntervalMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await githubApi(`/repos/${repo.owner}/${repo.name}/commits/${headBranch}/check-runs`, token);
    const data = (await res.json()) as { check_runs: Array<{ status: string; conclusion: string | null; started_at: string }> };
    const runs = data.check_runs.filter((r) => r.started_at);
    if (runs.length > 0 && runs.every((r) => r.status === "completed" && r.conclusion === "success")) {
      return true;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`CI did not pass on ${headBranch} within ${timeoutMs}ms`);
}

async function getLatestPrCommit(repo: { owner: string; name: string }, prNumber: number, token: string): Promise<string> {
  const res = await githubApi(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/commits`, token);
  const commits = (await res.json()) as Array<{ sha: string }>;
  return commits[commits.length - 1]?.sha ?? "";
}

async function createBrokenPr(repo: { owner: string; name: string }, baseBranch: string, token: string): Promise<{ prNumber: number; headBranch: string; headSha: string }> {
  const baseRefRes = await githubApi(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${baseBranch}`, token);
  const baseRef = (await baseRefRes.json()) as { object: { sha: string } };
  const baseSha = baseRef.object.sha;

  const branch = `daybreak/ci-heal-eval-${randomUUID().slice(0, 8)}`;
  await githubApi(`/repos/${repo.owner}/${repo.name}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  const brokenTest = `import { describe, it } from "node:test";\nimport assert from "node:assert";\n\ndescribe("daybreak-ci-heal", () => {\n  it("fails intentionally", () => {\n    assert.strictEqual(true, false, "broken by ci-self-heal eval");\n  });\n});\n`;
  const content = Buffer.from(brokenTest).toString("base64");
  await githubApi(`/repos/${repo.owner}/${repo.name}/contents/daybreak-ci-heal.test.js`, token, {
    method: "PUT",
    body: JSON.stringify({ message: "Add deliberately failing test for CI self-heal eval", content, branch }),
  });

  const prRes = await githubApi(`/repos/${repo.owner}/${repo.name}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title: "CI self-heal eval: broken test", head: branch, base: baseBranch, body: "This PR was created by the Daybreak CI self-heal eval harness." }),
  });
  const pr = (await prRes.json()) as { number: number; head: { sha: string; ref: string } };
  return { prNumber: pr.number, headBranch: pr.head.ref, headSha: pr.head.sha };
}

async function closePr(repo: { owner: string; name: string }, prNumber: number, token: string): Promise<void> {
  await githubApi(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`, token, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

async function deleteBranch(repo: { owner: string; name: string }, branch: string, token: string): Promise<void> {
  await githubApi(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`, token, { method: "DELETE" });
}

async function makeCheckRunWebhookPayload(
  repo: { owner: string; name: string },
  cloneUrl: string,
  pr: { number: number; headBranch: string; headSha: string },
  checkRun: { id: number; name: string; headSha: string },
) {
  const fullName = `${repo.owner}/${repo.name}`;
  const checkRunId = checkRun.id;
  const checkSuiteId = Math.floor(Math.random() * 1_000_000_000);
  return {
    action: "completed",
    repository: {
      full_name: fullName,
      clone_url: cloneUrl,
      default_branch: "main",
      owner: { login: repo.owner },
      name: repo.name,
    },
    check_run: {
      id: checkRunId,
      name: checkRun.name,
      head_sha: checkRun.headSha,
      status: "completed",
      conclusion: "failure",
      output: { title: "Test failed", summary: "Eval failure", text: "", annotations_count: 0, annotations_url: "" },
      check_suite: {
        id: checkSuiteId,
        head_branch: pr.headBranch,
        head_sha: pr.headSha,
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: pr.number, head: { ref: pr.headBranch }, base: { ref: "main" } }],
      },
      pull_requests: [{ number: pr.number, head: { ref: pr.headBranch }, base: { ref: "main" } }],
    },
    sender: { login: "daybreak-eval" },
  };
}

async function signAndSendWebhook(controlPlaneUrl: string, secret: string, payload: unknown): Promise<{ taskId?: string; prBranch?: string; headSha?: string; status?: string; ok?: boolean; note?: string }> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const res = await fetch(`${controlPlaneUrl}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "x-github-event": "check_run",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ...data,
    taskId: typeof data.taskId === "string" ? data.taskId : undefined,
    prBranch: typeof data.prBranch === "string" ? data.prBranch : undefined,
    headSha: typeof data.headSha === "string" ? data.headSha : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    ok: typeof data.ok === "boolean" ? data.ok : undefined,
    note: typeof data.note === "string" ? data.note : undefined,
  };
}

async function waitForHealTask(controlPlaneUrl: string, prNumber: number, headSha: string, timeoutMs: number, pollIntervalMs: number): Promise<{ id: string; status: string; headSha?: string; prBranch?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${controlPlaneUrl}/api/tasks`);
    if (res.ok) {
      const tasks = (await res.json()) as Array<{ id: string; status: string; prNumber?: number; headSha?: string; triggerSource?: string; prBranch?: string }>;
      const match = tasks.find((t) => t.triggerSource === "check_run" && t.prNumber === prNumber && t.headSha === headSha);
      if (match) return match as { id: string; status: string; headSha?: string; prBranch?: string };
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Heal task for PR #${prNumber} ${headSha} did not appear within ${timeoutMs}ms`);
}

async function waitForTaskCompletion(controlPlaneUrl: string, taskId: string, timeoutMs: number, pollIntervalMs: number): Promise<{ status: string; costUsd?: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${controlPlaneUrl}/api/tasks/${taskId}`);
    if (res.ok) {
      const task = (await res.json()) as { status: string; costUsd?: number };
      if (task.status === "complete" || task.status === "failed" || task.status === "abandoned") return task;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Heal task ${taskId} did not complete within ${timeoutMs}ms`);
}

function runFastIntegration() {
  console.log(pc.bold("\nRunning fast control-plane integration for CI self-healing...\n"));
  try {
    execSync("pnpm --filter @daybreak/control-plane test -- -t \"check_run\"", { cwd: repoRoot, stdio: "inherit" });
    console.log(pc.green("\nFast integration passed."));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fast integration failed: ${message}`);
  }
}

async function runRealE2E(options: CiSelfHealOptions) {
  const repo = parseRepo(options.repo);
  if (!repo) throw new Error(`Could not parse repo from ${options.repo}`);

  let prNumber = options.prNumber;
  let headBranch = options.headBranch;
  let headSha = options.headSha;
  let checkRunId = options.checkRunId ? Number(options.checkRunId) : undefined;
  const createdBranch = headBranch;

  if (prNumber === undefined) {
    console.log(pc.bold(`Creating broken PR in ${repo.owner}/${repo.name}...`));
    const created = await createBrokenPr(repo, options.baseBranch, options.githubToken);
    prNumber = created.prNumber;
    headBranch = created.headBranch;
    headSha = created.headSha;
    console.log(`Created PR #${prNumber} on branch ${headBranch} (${headSha.slice(0, 7)})`);
  } else {
    console.log(pc.bold(`Using existing PR #${prNumber}`));
    if (!headBranch || !headSha) {
      const prRes = await githubApi(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`, options.githubToken);
      const pr = (await prRes.json()) as { head: { ref: string; sha: string } };
      headBranch = pr.head.ref;
      headSha = pr.head.sha;
    }
  }

  if (checkRunId === undefined) {
    console.log("Waiting for a failed check_run on the PR branch...");
    const failed = await waitForFailedCheckRun(repo, headBranch!, options.githubToken, options.timeoutMs, options.pollIntervalMs);
    checkRunId = failed.checkRunId;
    headSha = failed.headSha;
    console.log(`Failed check_run: ${checkRunId} (${failed.name}) on ${headSha.slice(0, 7)}`);
  } else {
    console.log(`Using provided check_run id ${checkRunId}`);
  }

  const payload = await makeCheckRunWebhookPayload(repo, options.repo, { number: prNumber!, headBranch: headBranch!, headSha: headSha! }, { id: checkRunId!, name: "test", headSha: headSha! });

  console.log("Sending check_run webhook to control plane...");
  const webhookRes = await signAndSendWebhook(options.controlPlaneUrl, options.webhookSecret, payload);
  if (webhookRes.status !== "running" && webhookRes.status !== "pending" && !webhookRes.ok) {
    throw new Error(`Webhook not accepted: ${webhookRes.note || JSON.stringify(webhookRes)}`);
  }
  console.log(`Webhook accepted: taskId=${webhookRes.taskId ?? "-"} prBranch=${webhookRes.prBranch ?? "-"} headSha=${webhookRes.headSha ?? "-"}`);

  console.log("Polling for heal task...");
  const healTask = await waitForHealTask(options.controlPlaneUrl, prNumber!, headSha!, options.timeoutMs, options.pollIntervalMs);
  console.log(`Heal task ${healTask.id} is ${healTask.status}`);

  console.log("Waiting for heal task to complete...");
  const completed = await waitForTaskCompletion(options.controlPlaneUrl, healTask.id, options.timeoutMs, options.pollIntervalMs);
  console.log(`Heal task ${healTask.id} finished with status ${completed.status}${completed.costUsd !== undefined ? ` cost=$${completed.costUsd.toFixed(4)}` : ""}`);

  if (completed.status !== "complete") {
    throw new Error(`Heal task ${healTask.id} did not complete successfully: ${completed.status}`);
  }

  const commitBefore = await getLatestPrCommit(repo, prNumber!, options.githubToken);
  const deadline = Date.now() + options.timeoutMs;
  let newCommitPushed = false;
  while (Date.now() < deadline) {
    const latest = await getLatestPrCommit(repo, prNumber!, options.githubToken);
    if (latest !== commitBefore) {
      newCommitPushed = true;
      console.log(`New commit pushed: ${latest.slice(0, 7)}`);
      break;
    }
    await sleep(options.pollIntervalMs);
  }
  if (!newCommitPushed) throw new Error("No new commit was pushed to the PR branch");

  console.log("Waiting for the next CI run to pass...");
  await waitForCiPass(repo, headBranch!, options.githubToken, options.timeoutMs, options.pollIntervalMs);
  console.log(pc.green("CI is green."));

  if (options.cleanup) {
    console.log("Cleaning up PR and branch...");
    await closePr(repo, prNumber!, options.githubToken).catch(() => {});
    if (createdBranch) await deleteBranch(repo, createdBranch, options.githubToken).catch(() => {});
  }
}

export async function runCiSelfHeal() {
  const envPath = resolve(__dirname, "../../.env");
  loadConfig(envPath);

  const options: CiSelfHealOptions = {
    controlPlaneUrl: getArg("control-plane-url") || process.env.CONTROL_PLANE_URL || "http://localhost:8787",
    repo: getArg("repo") || process.env.HEAL_TARGET_REPO || process.env.EVAL_TARGET_REPO || "https://github.com/bezaspace/daybreak-target",
    baseBranch: getArg("base-branch") || process.env.HEAL_TARGET_BRANCH || process.env.EVAL_TARGET_BRANCH || "main",
    webhookSecret: getArg("webhook-secret") || process.env.GITHUB_WEBHOOK_SECRET || "test-secret",
    githubToken: getArg("github-token") || process.env.GITHUB_TOKEN || "",
    real: hasArg("real") || process.env.CI_SELF_HEAL_REAL === "1",
    timeoutMs: Number.parseInt(getArg("timeout") || process.env.HEAL_TIMEOUT_MS || process.env.EVAL_TIMEOUT_MS || "600000", 10),
    pollIntervalMs: Number.parseInt(getArg("poll-interval") || process.env.HEAL_POLL_INTERVAL_MS || "10000", 10),
    prNumber: getArg("pr-number") ? Number(getArg("pr-number")) : process.env.HEAL_PR_NUMBER ? Number(process.env.HEAL_PR_NUMBER) : undefined,
    headBranch: getArg("head-branch") || process.env.HEAL_HEAD_BRANCH || undefined,
    headSha: getArg("head-sha") || process.env.HEAL_HEAD_SHA || undefined,
    checkRunId: getArg("check-run-id") || process.env.HEAL_CHECK_RUN_ID || undefined,
    cleanup: hasArg("cleanup") || process.env.HEAL_CLEANUP === "1",
  };

  if (options.real) {
    if (!options.githubToken) throw new Error("GITHUB_TOKEN is required for real CI self-heal eval");
    await runRealE2E(options);
  } else {
    runFastIntegration();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCiSelfHeal().catch((error) => {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
