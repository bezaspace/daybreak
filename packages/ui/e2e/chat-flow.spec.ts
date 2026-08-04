import { test, expect } from "@playwright/test";

test.describe("chat-first session flow", () => {
  test("starts a session, sends a message, approves a tool, and shows the PR URL", async ({ page }) => {
    page.on("console", (msg) => {
      console.log(`[browser ${msg.type()}]`, msg.text());
    });
    page.on("pageerror", (err) => {
      console.error("[page error]", err.message);
    });

    await page.goto("/");

    await expect(page.getByText("Start a session")).toBeVisible();

    await page.getByPlaceholder("https://github.com/owner/repo").fill("https://github.com/daybreak/test");
    await page.getByPlaceholder("main").fill("main");
    await page.getByPlaceholder("What do you want the agent to do?").fill("Create a pull request");

    await page.getByRole("button", { name: "Run", exact: true }).click();

    await expect(page.getByText("I'll create a PR for this change.")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Approve gh pr create()?")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByRole("link", { name: "PR" })).toHaveAttribute(
      "href",
      "https://github.com/daybreak/test/pull/42",
    );
  });
});
