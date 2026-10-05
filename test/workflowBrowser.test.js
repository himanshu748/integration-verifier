import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDeskServer } from '../src/desk/server.js';

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function job(id, status = 'finished', extra = {}) {
  return { id, type: 'verify', status, startedAt: '2026-10-04T10:00:00.000Z',
    input: { app: 'fake-fallback', scenario: 'provider-fail', prompt: `Prompt for ${id}` },
    ...(status === 'finished' ? { verdict: 'contract_violation' } : {}), ...extra };
}
function detail(receipt) {
  return { job: receipt, execution: null, artifacts: receipt.status === 'finished' ? [{ name: 'evidence.json' }, { name: 'before/marker/browser-trace.zip' }] : [],
    result: receipt.status === 'finished' ? { verdict: { kind: receipt.verdict, reason: 'Controlled fixture violation' },
      observations: { workflowStatus: 200, workflowBody: { answer: receipt.input.prompt }, providerRequests: [{}] } } : null };
}
async function fixture(t, verifier) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nebius-sol-ui-'));
  let browser;
  const running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data'),
    ...(verifier ? { factories: { verifier: async () => verifier } } : {}) });
  t.after(async () => { await browser?.close(); await running.close(); await rm(root, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, timeout: 15000,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return { page, url: running.url };
}

test('Verifier clears old evidence during startup and reconciles accepted runs after a read failure', { timeout: 45000 }, async (t) => {
  const accepted = deferred();
  t.after(() => accepted.resolve());
  const old = job('saved-old'); let active = null; let starts = 0; let failReads = false;
  const { page, url } = await fixture(t, { handle: async (action, input) => {
    if (action === 'list') { if (failReads) throw new Error('Controlled read interruption'); return { runs: active ? [active, old] : [old], activeId: active?.status === 'running' ? active.id : null }; }
    if (action === 'detail') return detail(input.id === old.id ? old : active);
    if (action === 'run') { starts++; active = job('accepted-new', 'running', { input: { ...old.input, prompt: input.prompt } }); await accepted.promise; failReads = true; return { job: active }; }
  } });
  await page.goto(url + '/verifier');
  await page.locator('#verdict').getByText('Contract violation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  assert.equal(await page.locator('#verdict').textContent(), 'Starting run');
  assert.equal(await page.locator('#receipt').textContent(), '');
  assert.equal(await page.locator('#downloads button').count(), 0);
  accepted.resolve();
  await page.locator('#notice').getByText(/Refresh.*saved run|saved run.*Refresh/i).waitFor();
  assert.equal(await page.locator('#verify').isDisabled(), true);
  assert.equal(starts, 1);
  failReads = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('#verdict').getByText('running', { exact: true }).waitFor();
  assert.equal(await page.locator('#verify').isDisabled(), true);
  // Controlled lifecycle events exercise the same listeners as a BFCache return.
  await page.evaluate(() => {
    document.querySelector('#notice').textContent = '';
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.locator('#notice').getByText('Reconnected to the saved run. Waiting for its evidence.', { exact: true }).waitFor();
  active = job(active.id, 'interrupted', { error: 'The controlled server stopped.' });
  await page.locator('#notice').getByText(/interrupted.*No verified result/i).waitFor();
  assert.equal(await page.locator('#verify').isEnabled(), true);
  assert.equal(starts, 1, 'Restoring the page must resume saved reads without replaying the run');
});

test('Verifier preserves historical evidence and focus while another run finishes, and exposes all artifact paths', { timeout: 45000 }, async (t) => {
  const old = job('saved-old'); let active = job('active-new', 'running'); let starts = 0;
  const { page, url } = await fixture(t, { handle: async (action, input) => {
    if (action === 'list') return { runs: [active, old], activeId: active.status === 'running' ? active.id : null };
    if (action === 'detail') return detail(input.id === old.id ? old : active.status === 'finished'
      ? { ...active, status: 'failed', verdict: 'unverified', error: 'Controlled integrity downgrade.' } : active);
    if (action === 'run') { starts++; throw new Error('Controlled invalid input'); }
  }, artifact: async (_id, file) => Buffer.from(`Fixture artifact ${file}`) });
  await page.goto(url + '/verifier');
  await page.locator('#verdict').getByText('running', { exact: true }).waitFor();
  await page.locator('#history button').filter({ hasText: 'fake-fallback / provider-fail' }).nth(1).click();
  await page.locator('#verdict').getByText('Contract violation', { exact: true }).waitFor();
  await page.locator('#artifact-file').selectOption('before/marker/browser-trace.zip');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download selected artifact', exact: true }).click();
  const downloaded = await download;
  assert.equal(downloaded.suggestedFilename(), 'before-marker-browser-trace.zip');
  assert.equal(await readFile(await downloaded.path(), 'utf8'), 'Fixture artifact before/marker/browser-trace.zip');
  await page.locator('#artifact-file').focus();
  await page.evaluate(() => { window.retainedEvidence = document.querySelector('#result').firstChild; });
  active = job(active.id, 'finished', { verdict: 'observed_controlled_path' });
  await page.locator('#notice').getByText(/active-n.*failed.*No verified result/i).waitFor();
  assert.equal(await page.locator('#run-identity').getAttribute('data-run-id'), old.id);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'artifact-file');
  assert.equal(await page.evaluate(() => window.retainedEvidence === document.querySelector('#result').firstChild), true);
  assert.equal(await page.locator('#artifact-file').inputValue(), 'before/marker/browser-trace.zip');
  await page.getByRole('button', { name: 'Open completed run', exact: true }).click();
  await page.locator('#result').getByText(/Controlled integrity downgrade/).waitFor();
  assert.equal(await page.locator('#run-identity').getAttribute('data-run-id'), active.id);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-heading');
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  await page.locator('#notice').getByText(/Controlled invalid input/).waitFor();
  assert.equal(await page.locator('#verify').isEnabled(), true, 'a rejected request must unlock after a fresh list establishes no active run');
  assert.equal(starts, 1);
});

test('Verifier keeps a delayed start locked through manual refresh and lost-response reconciliation', { timeout: 45000 }, async (t) => {
  const acceptance = deferred(); const reconciliation = deferred(); const reconciling = deferred();
  t.after(() => { acceptance.resolve(); reconciliation.resolve(); });
  let active = null; let starts = 0; let lostResponse = false;
  const { page, url } = await fixture(t, { handle: async (action, input) => {
    if (action === 'list') {
      if (lostResponse) { reconciling.resolve(); await reconciliation.promise; }
      return { runs: active ? [active] : [], activeId: active?.id ?? null };
    }
    if (action === 'run') { starts++; await acceptance.promise; active = job('accepted-after-refresh', 'running', { input }); return { job: active }; }
    if (action === 'detail') return detail(active);
  } });
  await page.route('**/api/verifier/run', async (route) => {
    await route.fetch(); lostResponse = true; await route.fulfill({ status: 200, body: 'unreadable controlled response', contentType: 'text/plain' });
  });
  await page.goto(url + '/verifier');
  await page.locator('#history').getByText(/No runs yet/).waitFor();
  await page.getByRole('button', { name: 'Run verification', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await page.locator('#verify').isDisabled(), true);
  acceptance.resolve();
  await page.waitForFunction(() => document.querySelector('#verdict').textContent === 'Starting run');
  await reconciling.promise;
  assert.equal(await page.locator('#verify').isDisabled(), true);
  reconciliation.resolve();
  await page.locator('#notice').getByText(/existing run is still active/).waitFor();
  assert.equal(await page.locator('#run-identity').getAttribute('data-run-id'), active.id);
  assert.equal(await page.locator('#verify').isDisabled(), true);
  assert.equal(starts, 1);
});

test('Verifier ignores stale lists and detail selections, and retries an interrupted screenshot read', { timeout: 45000 }, async (t) => {
  const heldList = { entered: deferred(), release: deferred() }; const heldDetail = { entered: deferred(), release: deferred() };
  t.after(() => { heldList.release.resolve(); heldDetail.release.resolve(); });
  const old = job('saved-old'); let active = job('active-new', 'running'); let images = 0;
  const { page, url } = await fixture(t, { handle: async (action, input) => {
    if (action === 'list') return { runs: [active, old], activeId: active.status === 'running' ? active.id : null };
    if (action === 'detail') {
      const value = detail(input.id === old.id ? old : active);
      if (input.id === old.id) value.artifacts.push({ name: 'workflow.png' });
      return value;
    }
  }, artifact: async () => {
    images++; if (images === 1) throw new Error('Controlled screenshot read failure');
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
  } });
  await page.goto(url + '/verifier');
  await page.locator('#verdict').getByText('running', { exact: true }).waitFor();
  let delayList = true;
  await page.route('**/api/verifier/list', async (route) => {
    const hold = delayList; delayList = false;
    const response = await route.fetch();
    if (hold) { heldList.entered.resolve(); await heldList.release.promise; }
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await heldList.entered.promise;
  active = job(active.id);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('#verify').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#verify').disabled);
  heldList.release.resolve();
  await page.waitForFunction(() => document.querySelector('#verdict').textContent === 'Contract violation');
  assert.equal(await page.locator('#verify').isEnabled(), true);
  let delayDetail = true;
  await page.route('**/api/verifier/detail', async (route) => {
    const hold = delayDetail && route.request().postDataJSON().id === old.id;
    if (hold) delayDetail = false;
    const response = await route.fetch();
    if (hold) { heldDetail.entered.resolve(); await heldDetail.release.promise; }
    await route.fulfill({ response });
  });
  await page.locator('#history button[data-run-id="saved-old"]').click();
  await heldDetail.entered.promise;
  await page.locator('#history button[data-run-id="active-new"]').click();
  await page.locator('#run-identity[data-run-id="active-new"]').waitFor();
  heldDetail.release.resolve();
  assert.equal(await page.locator('#run-identity').getAttribute('data-run-id'), active.id);
  await page.locator('#history button[data-run-id="saved-old"]').click();
  await page.locator('#notice').getByText(/Controlled screenshot read failure/).waitFor();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#workflow-image-slot img')?.naturalWidth === 1);
  assert.equal(images, 2);
  assert.equal(await page.locator('#run-identity').getAttribute('data-run-id'), old.id);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.waitForFunction(() => document.querySelector('#workflow-image-slot img')?.naturalWidth === 1);
  assert.equal(images, 3, 'A restored page must replace the revoked screenshot URL from saved bytes');
});
