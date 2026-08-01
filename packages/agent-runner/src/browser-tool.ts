import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { Type, type Static } from "typebox";

const BrowserActionSchema = Type.Union([
  Type.Literal("navigate"),
  Type.Literal("screenshot"),
  Type.Literal("getText"),
  Type.Literal("getHtml"),
  Type.Literal("click"),
  Type.Literal("fill"),
  Type.Literal("evaluate"),
]);

const BrowserParamsSchema = Type.Object({
  action: Type.Optional(BrowserActionSchema),
  url: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  script: Type.Optional(Type.String()),
  waitForText: Type.Optional(Type.String()),
});

let browserPromise: Promise<Browser> | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

function findChrome(): string | undefined {
  const candidates = [
    process.env.PW_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chrome",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const which = execSync("which chromium chromium-browser google-chrome 2>/dev/null", { encoding: "utf8" }).trim();
    const first = which.split("\n")[0];
    if (first) {
      return first;
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (!browserPromise) {
    const executablePath = findChrome();
    if (!executablePath) {
      throw new Error(
        "No Chrome/Chromium executable found. Install chromium or set PW_EXECUTABLE_PATH.",
      );
    }

    browserPromise = chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });
    browser = await browserPromise;
  }
  if (!browser) {
    throw new Error("Browser launch failed");
  }
  return browser;
}

async function getPage(): Promise<Page> {
  const b = await getBrowser();
  if (!context) {
    context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  }
  if (!page) {
    page = await context.newPage();
  }
  return page;
}

export async function closeBrowser(): Promise<void> {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  page = undefined;
  context = undefined;
  browser = undefined;
  browserPromise = undefined;
}

export const browserTool = defineTool({
  name: "browser",
  label: "Browser",
  description:
    "Control a headless Chromium browser to navigate web pages, take screenshots, read text/html, click or fill elements, and evaluate JavaScript. Use it to visually verify web applications or inspect remote pages.",
  promptSnippet:
    'browser({ action?: "navigate" | "screenshot" | "getText" | "getHtml" | "click" | "fill" | "evaluate", url?: string, selector?: string, value?: string, script?: string, waitForText?: string })',
  promptGuidelines: [
    "Use `navigate` with a `url` to open a page.",
    "Use `screenshot` to capture the current page as an image; the result is streamed to the dashboard.",
    "Use `getText` (optionally with `selector`) to read visible text.",
    "Use `getHtml` to read the page source.",
    "Use `click` with `selector` and `fill` with `selector`/`value` to interact with the page.",
    "Use `evaluate` with `script` to run JavaScript and return a JSON-serializable value.",
  ],
  parameters: BrowserParamsSchema,
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate) {
    const action = params.action || "navigate";
    const p = await getPage();
    let resultText = "";
    const details: Record<string, unknown> = { action };

    try {
      switch (action) {
        case "navigate": {
          if (!params.url) {
            throw new Error("url is required for navigate");
          }
          await p.goto(params.url, { waitUntil: "networkidle" });
          const title = await p.title();
          resultText = `Navigated to ${params.url}. Title: ${title}`;
          details.url = params.url;
          details.title = title;
          break;
        }
        case "screenshot": {
          const buffer = await p.screenshot({ type: "png", fullPage: true });
          const base64 = buffer.toString("base64");
          details.screenshotBase64 = base64;
          details.mimeType = "image/png";
          details.url = p.url();
          onUpdate?.({
            content: [{ type: "text", text: "Screenshot captured" }],
            details,
          });
          resultText = `Screenshot captured (${buffer.length} bytes)`;
          break;
        }
        case "getText": {
          const locator = params.selector ? p.locator(params.selector) : p.locator("body");
          const text = await locator.innerText();
          resultText = text;
          details.text = text;
          if (params.selector) details.selector = params.selector;
          break;
        }
        case "getHtml": {
          const html = await p.content();
          resultText = html.slice(0, 5000);
          details.htmlLength = html.length;
          break;
        }
        case "click": {
          if (!params.selector) {
            throw new Error("selector is required for click");
          }
          await p.locator(params.selector).click();
          resultText = `Clicked ${params.selector}`;
          details.selector = params.selector;
          break;
        }
        case "fill": {
          if (!params.selector || params.value === undefined) {
            throw new Error("selector and value are required for fill");
          }
          await p.locator(params.selector).fill(params.value);
          resultText = `Filled ${params.selector}`;
          details.selector = params.selector;
          details.value = params.value;
          break;
        }
        case "evaluate": {
          if (!params.script) {
            throw new Error("script is required for evaluate");
          }
          const value = await p.evaluate((script) => {
            // eslint-disable-next-line no-eval
            return eval(script);
          }, params.script);
          resultText = JSON.stringify(value).slice(0, 2000);
          details.result = value;
          break;
        }
        default: {
          throw new Error(`Unknown browser action: ${action}`);
        }
      }

      if (params.waitForText) {
        await p
          .waitForFunction((text) => document.body.innerText.includes(text), params.waitForText, {
            timeout: 10000,
          })
          .catch(() => {
            // ignore timeout
          });
      }
    } catch (error) {
      await closeBrowser();
      throw error;
    }

    if (action !== "screenshot") {
      details.url = p.url();
    }

    return {
      content: [{ type: "text", text: resultText.slice(0, 4000) }],
      details,
    };
  },
});

export type BrowserToolParams = Static<typeof BrowserParamsSchema>;
