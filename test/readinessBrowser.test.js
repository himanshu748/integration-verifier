import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';
import { createVerifierService } from '../src/verifier/service.js';

async function browserFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nebius-readiness-'));
  let running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data'), ...options });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  t.after(async () => { await browser.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  return { root, page, url: running.url, restart: async () => {
    const port = Number(new URL(running.url).port);
    await running.close();
    running = await startDeskServer({ port, workspaceRoot: root, dataRoot: path.join(root, 'data'), ...options });
  } };
}

test('Verifier resumes polling after a transient connection failure without starting another run', { timeout: 60000 }, async (t) => {
  const { page, url } = await browserFixture(t);
  let lists = 0; let runs = 0; let interrupted = false;
  await page.route('**/api/verifier/list', async (route) => {
    lists++;
    if (lists === 3) { interrupted = true; await route.abort('connectionreset'); }
    else await route.continue();
  });
  page.on('request', (request) => { if (request.url().endsWith('/api/verifier/run')) runs++; });
  await page.goto(url + '/verifier');
  await page.locator('#history').getByText(/No runs yet/).waitFor();
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#verdict').textContent === 'Contract violation', undefined, { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector('#verify').disabled);
  assert.equal(interrupted, true);
  assert.equal(runs, 1);
});

test('Verifier refuses structurally valid evidence changed after its final receipt', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nebius-receipt-integrity-'));
  const service = await createVerifierService({ dataRoot: root });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const { job } = await service.handle('run', { type: 'verify', app: 'fake-fallback', scenario: 'provider-fail' });
  await service.close();
  const initial = await service.handle('detail', { id: job.id });
  assert.equal(initial.job.status, 'finished');
  const file = path.join(root, 'verifier', job.id, 'artifacts/evidence.json');
  const original = await readFile(file);
  assert.equal(initial.job.primaryArtifactSha256, createHash('sha256').update(original).digest('hex'));
  const changed = JSON.parse(original);
  changed.observations.workflowBody.answer = 'A different but structurally valid answer';
  await writeFile(file, JSON.stringify(changed));
  const invalid = await service.handle('detail', { id: job.id });
  assert.equal(invalid.job.status, 'failed');
  assert.equal(invalid.job.verdict, 'unverified');
  assert.equal(invalid.result, null);
  assert.equal(invalid.job.evidenceIntegrity, 'changed');
  await writeFile(file, original);
  assert.equal((await service.handle('detail', { id: job.id })).job.status, 'finished');
});


test('Verifier invalidates Sandbox send consent after a changed workflow prompt', { timeout: 45000 }, async (t) => {
  const status = { configured: true, sandboxConfigured: true, model: 'nvidia/fixture' };
  const { page, url } = await browserFixture(t, { inferenceRuntime: { status: () => status, handle: async () => status } });
  await page.goto(url + '/verifier');
  await page.locator('#sponsor-status').getByText(/Server credentials configured/).waitFor();
  await page.locator('#sponsor-consent').check();
  assert.equal(await page.locator('#sandbox-verify').isEnabled(), true);
  await page.getByLabel('Workflow prompt', { exact: true }).fill('An edited prompt that has not been approved');
  assert.equal(await page.locator('#sponsor-consent').isChecked(), false);
  assert.equal(await page.locator('#sandbox-verify').isDisabled(), true);
});
