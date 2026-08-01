#!/usr/bin/env node
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const outdir = resolve(import.meta.dirname ?? process.cwd(), "../dist");
  const outfile = resolve(outdir, "run-task.cjs");

  await build({
    entryPoints: [resolve(import.meta.dirname ?? process.cwd(), "run-task.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    external: ["node:*", "playwright-core", "chromium-bidi", "chromium-bidi/*", "fsevents"],
    logLevel: "warning",
  });

  let code = readFileSync(outfile, "utf8");
  code = code.replace(
    /var (import_meta(\d*)) = \{\};/g,
    'var $1 = { url: require("url").pathToFileURL(__filename).href };',
  );
  writeFileSync(outfile, code);

  console.log(`Bundled agent runner to ${outfile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
