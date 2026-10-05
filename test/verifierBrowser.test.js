import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';

test('verifier browser retains actual failure evidence, marker propagation, and a verified repair replay', { timeout: 240000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verifier-browser-'));
  const running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data') });
  let browser;
  t.after(async () => { await browser?.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, timeout: 20000, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  async function expectVerdict(expected, timeout = 60000) {
    try {
      await page.waitForFunction((label) => {
        const value = document.querySelector('#verdict').textContent;
        return value === label || value === 'Unverified' || document.querySelector('#notice').dataset.error === 'true';
      }, expected, { timeout });
    } catch (error) {
      assert.fail(`${error.message}\nNotice: ${await page.locator('#notice').textContent()}\nVerdict: ${await page.locator('#verdict').textContent()}\nReceipt: ${await page.locator('#receipt').textContent()}\nBrowser errors: ${JSON.stringify(errors)}`);
    }
    assert.notEqual(await page.locator('#notice').getAttribute('data-error'), 'true', await page.locator('#notice').textContent());
    assert.equal(await page.locator('#verdict').textContent(), expected, await page.locator('#receipt').textContent());
  }
  await page.goto(running.url + '/verifier');
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  await expectVerdict('Contract violation');
  assert.match(await page.locator('#result').textContent(), /provider failure did not satisfy/);
  await page.waitForFunction(() => document.querySelector('#workflow-image-slot img')?.naturalWidth > 0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download evidence.json', exact: true }).click();
  const evidence = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  assert.equal(evidence.verdict.kind, 'contract_violation');
  assert.equal(evidence.liveInferenceVerified, false);
  assert.equal(evidence.observations.providerRequests.length, 1);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#verdict').textContent === 'Contract violation');
  await page.locator('[name="app"]').selectOption('honest-live');
  await page.locator('[name="scenario"]').selectOption('marker');
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  await expectVerdict('Controlled path observed');
  await page.getByRole('button', { name: 'Repair and replay', exact: true }).click();
  await expectVerdict('Local repair verified', 150000);
  const envelope = JSON.parse(await page.locator('#receipt').textContent());
  assert.equal(envelope.job.status, 'finished');
  assert.equal(envelope.execution, null, 'Local repair must not claim remote execution');
  const receipt = envelope.result;
  assert.equal(receipt.status, 'verified_local_repair');
  assert.equal(await page.locator('.verifier-comparison tbody tr').count(), 3);
  assert.match(await page.locator('.verifier-comparison').textContent(), /Provider unavailable.*Contract violation.*Failure disclosed/s);
  assert.match(await page.locator('.verifier-comparison').textContent(), /Successful marker.*Controlled path observed.*Controlled path observed/s);
  assert.match(await page.locator('.evidence-integrity').textContent(), /Receipt matches/);
  assert.ok(Object.values(receipt.checks).every(Boolean));
  assert.equal(receipt.before.exitCode, 1);
  assert.equal(receipt.after.exitCode, 0);
  assert.equal(await page.locator('#history li').count(), 3);
  const review = path.resolve('.impeccable/review/2026-09-29');
  await mkdir(review, { recursive: true });
  await page.waitForFunction(() => document.querySelector('#workflow-image-slot img')?.naturalWidth > 0);
  for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.getByRole('table', { name: 'Recorded outcomes from the unchanged regression' }).count(), 1);
    assert.equal(await page.locator('.comparison-phase').first().isVisible(), width === 390);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(review, `verifier-${name}.png`), fullPage: true });
  }
  await page.goto(running.url + '/');
  assert.equal(await page.locator('h1').count(), 1);
  assert.match(await page.locator('h1').textContent(), /Did the provider/);
  assert.equal(await page.getByRole('link', { name: /Open verifier/ }).count(), 1);
  assert.equal(await page.locator('a[href="/resumer"], a[href="/scope"], a[href="/route/"]').count(), 0);
  assert.deepEqual(errors, []);
});
