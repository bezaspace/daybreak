#!/usr/bin/env node
import { loadConfig } from "@daybreak/shared";
import { Template, defaultBuildLogger } from "e2b";
import pc from "picocolors";

async function main() {
  const config = loadConfig();
  if (!config.e2bApiKey) {
    console.error(pc.red("E2B_API_KEY is required"));
    process.exit(1);
  }

  const templateName = process.argv.find((arg) => arg.startsWith("--name="))?.split("=")[1] || "daybreak-browser";
  const memoryMB = Number.parseInt(process.argv.find((arg) => arg.startsWith("--memory="))?.split("=")[1] || "1536", 10);
  const cpuCount = Number.parseInt(process.argv.find((arg) => arg.startsWith("--cpu="))?.split("=")[1] || "2", 10);

  console.log(pc.bold(`[build-template] building ${templateName} with ${cpuCount} vCPU / ${memoryMB} MB...`));

  const node22Url = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz";
  const nodeDir = "/home/user/.node";

  const template = Template()
    .fromBaseImage()
    .runCmd("apt-get update -qq && apt-get install -y -qq chromium chromium-driver 2>&1 | tail -n 50", { user: "root" })
    .runCmd(
      `mkdir -p ${nodeDir} && curl -fsSL ${node22Url} | tar -xJf - -C ${nodeDir} --strip-components=1 && ${nodeDir}/bin/node --version`,
    )
    .runCmd(
      `cd /home/user && npm_config_loglevel=error npm_config_audit=false npm_config_fund=false ${nodeDir}/bin/npm install playwright-core@1.62.1 chromium-bidi 2>&1 | tail -n 30`,
    );

  const buildInfo = await Template.build(template, templateName, {
    cpuCount,
    memoryMB,
    onBuildLogs: defaultBuildLogger(),
    apiKey: config.e2bApiKey,
  });

  console.log(pc.bold(`[build-template] done: ${buildInfo.templateId}`));
  console.log(`Set E2B_TEMPLATE=${templateName} to use this template in sandbox.ts`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
