import path from "node:path";
import { chromium } from "playwright";

export async function runBrowserWorkflow({ baseUrl, prompt, outputDir }) {
  const screenshotPath = path.join(outputDir, "workflow.png");
  const tracePath = path.join(outputDir, "browser-trace.zip");
  const browser = await chromium.launch({
    headless: true, timeout: 20_000,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  let context;
  try {
    context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    const browserRequests = [];
    const browserResponses = [];

    page.on("request", (request) => {
      browserRequests.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType()
      });
    });

    page.on("response", (response) => {
      browserResponses.push({
        status: response.status(),
        url: response.url()
      });
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.fill("input[name='prompt']", prompt);
    const [workflowResponse] = await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST"
      ),
      page.click("button[type='submit']")
    ]);
    await page.waitForFunction(() => {
      const result = document.querySelector("#result");
      return result && result.textContent && result.textContent.trim().length > 0;
    });

    const workflowText = await page.locator("#result").textContent();
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      mode: "browser",
      pageTitle: await page.title(),
      workflowStatus: workflowResponse.status(),
      workflowBody: parseWorkflowBody(workflowText),
      workflowText,
      browserRequests,
      browserResponses,
      screenshotPath,
      tracePath
    };
  } finally {
    try { if (context) await context.tracing.stop({ path: tracePath }); }
    finally { await browser.close(); }
  }
}

function parseWorkflowBody(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { parseError: true, raw: text || "" };
  }
}
