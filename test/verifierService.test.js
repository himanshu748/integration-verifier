import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createVerifierService } from '../src/verifier/service.js';
import { createDefaultContract } from '../src/verifier/contract.js';
import { judgeEvidence } from '../src/verifier/judge.js';
import { sampleAppEntry } from '../src/verifier/run.js';
import { createLocalRepair } from '../src/verifier/repair.js';

const request = { type: 'verify', app: 'fake-fallback', scenario: 'provider-fail' };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'verifier-service-test-'));
  const service = await createVerifierService({ dataRoot, ...options });
  t.after(async () => { await service.close(); await rm(dataRoot, { recursive: true, force: true }); });
  return { dataRoot, service };
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
function evidenceRecord(outputDir, extra = {}) {
  const contract = createDefaultContract();
  const marker = 'VERIFIER_MARKER_UNIT_TEST';
  const observations = {
    pageLoaded: true, workflowStatus: 200,
    workflowBody: { answer: 'Live AI answer: fixture fallback', status: 'live', disclosure: 'provider response displayed' },
    browserRequests: [{ method: 'POST', url: 'http://127.0.0.1:12345/api/chat', resourceType: 'fetch' }],
    browserResponses: [{ status: 200, url: 'http://127.0.0.1:12345/api/chat' }],
    providerRequests: [{ method: 'POST', url: contract.providerPath, authorizationPresent: true,
      body: { model: contract.expectedModel, messages: [{ role: 'user', content: 'write a launch checklist' }] } }],
    syntheticMarker: marker, screenshotPath: path.join(outputDir, 'workflow.png'), tracePath: path.join(outputDir, 'browser-trace.zip'),
  };
  return { verifierVersion: '0.2.0', startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:01.000Z',
    evidenceScope: 'local-controlled-provider', liveInferenceVerified: false, sourceSha256: hash('unit test source'),
    contractSha256: hash(JSON.stringify(contract)), app: request.app, scenario: request.scenario, contract, observations,
    verdict: judgeEvidence({ ...observations, scenario: request.scenario, contract, marker }), repair: null, ...extra };
}
async function evidence(outputDir, extra = {}) {
  await mkdir(outputDir, { recursive: true });
  const record = evidenceRecord(outputDir, extra);
  await writeFile(path.join(outputDir, 'evidence.json'), JSON.stringify(record));
  return record;
}
function repairRecord(outputDir, verified = true) {
  const verdict = (kind) => ({ kind, reason: 'Synthetic unit-test replay observation.' });
  return {
    status: verified ? 'verified_local_repair' : 'not_verified', generatedAt: '2026-09-29T00:00:01.000Z',
    repairSource: 'deterministic-local-template', evidenceScope: 'local-controlled-provider', liveInferenceVerified: false,
    regressionSha256: hash('fixed regression'), contractSha256: hash(JSON.stringify(createDefaultContract())),
    originalSourceSha256: hash('original source'), repairedSourceSha256: hash('repaired source'),
    checks: { regressionFailedBefore: true, regressionPassedAfter: verified, failuresExposedBefore: true,
      failuresDisclosedAfter: true, successfulPathPreserved: true, sourceEvidenceMatches: true,
      unchangedContract: true, unchangedRegression: true, originalSourceUnchanged: true },
    before: { exitCode: 1, logPath: path.join(outputDir, 'before/regression.log') },
    after: { exitCode: verified ? 0 : 1, logPath: path.join(outputDir, 'after/regression.log') },
    scenarios: ['provider-fail', 'malformed', 'marker'].map((scenario) => ({ scenario,
      before: verdict(scenario === 'marker' ? 'observed_controlled_path' : 'contract_violation'),
      after: verdict(scenario === 'marker' ? 'observed_controlled_path' : 'observed_honest_failure'),
      beforeEvidence: `before/${scenario}/evidence.json`, afterEvidence: `after/${scenario}/evidence.json`,
    })),
  };
}
async function repairEvidence(outputDir, verified = true) {
  await mkdir(outputDir, { recursive: true });
  const record = repairRecord(outputDir, verified);
  await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(record));
  return record;
}
function invalidResults(type, outputDir) {
  const full = type === 'verify' ? evidenceRecord(outputDir) : repairRecord(outputDir);
  const common = [
    ['empty object', {}], ['null', null], ['array', []],
    ['incomplete local claim', { evidenceScope: 'local-controlled-provider', liveInferenceVerified: false,
      ...(type === 'verify' ? { verdict: full.verdict } : { status: full.status }) }],
    ['wrong scope', { ...full, evidenceScope: 'live-provider' }],
    ['invalid hash', { ...full, contractSha256: 'not-a-hash' }],
  ];
  return [...common, ...(type === 'verify' ? [
    ['missing observations', { ...full, observations: undefined }],
    ['wrong observation types', { ...full, observations: { ...full.observations, browserRequests: {}, workflowStatus: '200' } }],
    ['invalid verdict', { ...full, verdict: { kind: 'success', reason: 'Unsupported verdict.' } }],
    ['different app', { ...full, app: 'honest-live' }],
    ['different scenario', { ...full, scenario: 'marker' }],
    ['invalid date', { ...full, completedAt: 'not-a-date' }],
  ] : [
    ['missing checks', { ...full, checks: undefined }],
    ['nonboolean check', { ...full, checks: { ...full.checks, unchangedContract: 'true' } }],
    ['false check with positive status', { ...full, checks: { ...full.checks, unchangedRegression: false } }],
    ['missing scenario', { ...full, scenarios: full.scenarios.slice(1) }],
    ['invalid scenario verdict', { ...full, scenarios: full.scenarios.map((entry, index) => index === 0 ? { ...entry, after: { kind: 'success', reason: 'Unsupported verdict.' } } : entry) }],
    ['positive result with failed regression', { ...full, after: { ...full.after, exitCode: 1 } }],
    ['invalid date', { ...full, generatedAt: 'not-a-date' }],
  ])];
}
async function completed(service, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await service.handle('detail', { id });
    if (result.job.status !== 'running') return result;
    await delay(5);
  }
  assert.fail('Run did not publish a final receipt.');
}

test('runs persist fresh receipts and evidence, with completion separate from the verification verdict', async (t) => {
  const calls = [];
  const { service, dataRoot } = await fixture(t, { verify: async (input) => {
    calls.push(input);
    await evidence(input.outputDir, { invocation: calls.length });
    await writeFile(path.join(input.outputDir, 'app.log'), `run ${calls.length}\n`);
  } });
  const ids = [];
  for (let invocation = 1; invocation <= 2; invocation++) {
    const accepted = await service.handle('run', { ...request, prompt: 'Check the launch result' });
    ids.push(accepted.job.id);
    assert.equal(accepted.job.status, 'running');
    assert.equal(accepted.job.liveInferenceVerified, false);
    const detail = await completed(service, accepted.job.id);
    assert.equal(detail.job.status, 'finished');
    assert.equal(detail.job.verdict, 'contract_violation');
    assert.equal(detail.job.liveInferenceVerified, false);
    assert.equal(detail.result.invocation, invocation);
    assert.equal(detail.result.liveInferenceVerified, false);
    assert.ok(Number.isFinite(Date.parse(detail.job.finishedAt)));
    assert.ok(detail.artifacts.some((file) => file.name === 'evidence.json'));
    assert.equal((await service.artifact(accepted.job.id, 'app.log')).toString(), `run ${invocation}\n`);
    const persisted = JSON.parse(await readFile(path.join(dataRoot, 'verifier', accepted.job.id, 'job.json'), 'utf8'));
    assert.deepEqual(persisted, detail.job);
    assert.equal(calls[invocation - 1].outputDir, path.join(dataRoot, 'verifier', accepted.job.id, 'artifacts'));
    assert.equal(calls[invocation - 1].prompt, 'Check the launch result');
    assert.equal(calls[invocation - 1].app, request.app);
    assert.equal(calls[invocation - 1].scenario, request.scenario);
  }
  assert.notEqual(ids[0], ids[1]);
  const listing = await service.handle('list', {});
  assert.equal(listing.activeId, null);
  assert.equal(listing.runs.length, 2);
  assert.deepEqual(new Set(listing.runs.map((run) => run.id)), new Set(ids));
});

test('repair reads its persisted summary without promoting a negative result into success', async (t) => {
  let called = 0;
  const { service } = await fixture(t, { verify: () => assert.fail('Repair dispatched to verification.'), repair: async ({ outputDir }) => {
    called++;
    await repairEvidence(outputDir, false);
  } });
  const { job } = await service.handle('run', { type: 'repair' });
  const detail = await completed(service, job.id);
  assert.equal(called, 1);
  assert.equal(detail.job.status, 'finished');
  assert.equal(detail.job.verdict, 'not_verified');
  assert.equal(detail.result.liveInferenceVerified, false);
});

test('Sandbox requests require consent and never fall back to host execution', async (t) => {
  const { service } = await fixture(t, { verify: () => assert.fail('Remote request executed locally.'), sandbox: async () => { throw new Error('Remote execution unavailable'); } });
  await assert.rejects(service.handle('run', { ...request, execution: 'sandbox' }), /Confirm sending/);
  await assert.rejects(service.handle('run', { type: 'repair', repairMode: 'nemotron' }), /only in Nebius Sandboxes/);
  const { job } = await service.handle('run', { ...request, execution: 'sandbox', consent: true });
  const detail = await completed(service, job.id);
  assert.equal(detail.job.status, 'failed');
  assert.equal(detail.job.verdict, 'unverified');
  assert.equal(detail.result, null);
});

test('Nemotron candidate and Sandbox evidence are separately bound and tampering invalidates saved proof', async (t) => {
  const original = await readFile(sampleAppEntry, 'utf8');
  const candidate = createLocalRepair(original).repairedSource;
  let generationCount = 0;
  const { service, dataRoot } = await fixture(t, {
    repair: () => assert.fail('Generated code executed on host.'),
    inferenceRuntime: { status: () => ({ sandboxConfigured: true }), generate: async (input) => {
      generationCount++;
      assert.equal(input.input.source, original);
      return { value: { source: candidate, explanation: 'Fixture candidate only.' }, inference: { model: 'nvidia/fixture-nemotron', liveInferenceVerified: false, transport: 'test-fixture' } };
    } },
    sandbox: async ({ outputDir, candidateSource }) => {
      assert.equal(candidateSource, candidate);
      await mkdir(outputDir);
      const result = { ...repairRecord(outputDir), repairSource: 'nemotron-generated', originalSourceSha256: hash(original), repairedSourceSha256: hash(candidate) };
      const bytes = JSON.stringify(result);
      await writeFile(path.join(outputDir, 'summary.json'), bytes);
      await writeFile(path.join(outputDir, 'sandbox.json'), JSON.stringify({ provider: 'nebius-token-factory-sandboxes', transport: 'test-fixture', liveSandboxVerified: false, status: 'fixture-verified', executionId: 'fixture-only', exitCode: 0, candidateSourceSha256: hash(candidate), artifactHashes: { 'summary.json': hash(bytes) } }));
    },
  });
  const { job } = await service.handle('run', { type: 'repair', execution: 'sandbox', repairMode: 'nemotron', consent: true });
  const detail = await completed(service, job.id);
  assert.equal(generationCount, 1);
  assert.equal(detail.job.status, 'finished');
  assert.equal(detail.result.repairSource, 'nemotron-generated');
  assert.equal(detail.execution.liveSandboxVerified, false);
  assert.equal(detail.job.inference.inference.liveInferenceVerified, false);
  assert.equal(detail.job.liveInferenceVerified, false, 'Controlled verification itself is not live inference');
  const sandboxPath = path.join(dataRoot, 'verifier', job.id, 'artifacts/sandbox.json');
  await writeFile(sandboxPath, JSON.stringify({ ...detail.execution, exitCode: 137 }));
  assert.equal((await service.handle('detail', { id: job.id })).job.status, 'failed', 'Terminated process cannot claim a verified repair');
  await writeFile(sandboxPath, JSON.stringify(detail.execution));
  const recordPath = path.join(dataRoot, 'verifier', job.id, 'artifacts/summary.json');
  await writeFile(recordPath, JSON.stringify({ ...detail.result, repairedSourceSha256: hash('different candidate') }));
  const changed = await service.handle('detail', { id: job.id });
  assert.equal(changed.job.status, 'failed');
  assert.equal(changed.result, null);
});

test('missing, malformed, thrown, and out-of-scope results become failed unverified receipts', async (t) => {
  for (const [name, verify] of [
    ['missing output', async () => ({ verdict: { kind: 'observed_controlled_path' } })],
    ['executor error', async () => { throw new Error('Controlled runner failure'); }],
    ['invalid JSON', async ({ outputDir }) => { await mkdir(outputDir); await writeFile(path.join(outputDir, 'evidence.json'), '{'); }],
    ['live claim', async ({ outputDir }) => evidence(outputDir, { liveInferenceVerified: true })],
    ['missing scope declaration', async ({ outputDir }) => evidence(outputDir, { liveInferenceVerified: undefined })],
  ]) {
    await t.test(name, async (subtest) => {
      const { service } = await fixture(subtest, { verify });
      const { job } = await service.handle('run', request);
      await service.close();
      const receipt = (await service.handle('list', {})).runs.find((run) => run.id === job.id);
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.verdict, 'unverified');
      assert.equal(receipt.liveInferenceVerified, false);
      assert.equal(typeof receipt.error, 'string');
      assert.ok(receipt.error.length > 0);
      assert.ok(Number.isFinite(Date.parse(receipt.finishedAt)));
      const detail = await service.handle('detail', { id: job.id });
      assert.deepEqual(detail.job, receipt);
      if (['missing output', 'executor error', 'invalid JSON'].includes(name)) assert.equal(detail.result, null);
    });
  }
});

test('finished runs whose primary evidence is missing or unreadable are presented as failed and unverified', async (t) => {
  for (const type of ['verify', 'repair']) {
    await t.test(type, async (subtest) => {
      const primary = type === 'repair' ? 'summary.json' : 'evidence.json';
      const { service, dataRoot } = await fixture(subtest, {
        verify: async ({ outputDir }) => evidence(outputDir),
        repair: async ({ outputDir }) => repairEvidence(outputDir),
      });
      const { job } = await service.handle('run', type === 'verify' ? request : { type });
      await service.close();
      assert.equal((await service.handle('detail', { id: job.id })).job.status, 'finished');
      const evidencePath = path.join(dataRoot, 'verifier', job.id, 'artifacts', primary);
      await rm(evidencePath);
      for (const state of ['missing', 'malformed']) {
        if (state === 'malformed') await writeFile(evidencePath, '{invalid json');
        const detail = await service.handle('detail', { id: job.id });
        assert.equal(detail.job.status, 'failed', state);
        assert.equal(detail.job.verdict, 'unverified', state);
        assert.equal(detail.job.liveInferenceVerified, false, state);
        assert.equal(detail.result, null, state);
        assert.match(detail.job.error, /missing or unreadable/, state);
      }
    });
  }
});

test('incomplete or contradictory JSON execution evidence cannot finish with a verdict', async (t) => {
  for (const type of ['verify', 'repair']) {
    const primary = type === 'verify' ? 'evidence.json' : 'summary.json';
    for (const [name] of invalidResults(type, '/fixture-output')) {
      await t.test(`${type}: ${name}`, async (subtest) => {
        const executor = async ({ outputDir }) => {
          await mkdir(outputDir, { recursive: true });
          const [, invalid] = invalidResults(type, outputDir).find(([label]) => label === name);
          await writeFile(path.join(outputDir, primary), JSON.stringify(invalid));
        };
        const { service } = await fixture(subtest, { [type]: executor });
        const { job } = await service.handle('run', type === 'verify' ? request : { type });
        await service.close();
        const detail = await service.handle('detail', { id: job.id });
        assert.equal(detail.job.status, 'failed');
        assert.equal(detail.job.verdict, 'unverified');
        assert.equal(detail.job.liveInferenceVerified, false);
        assert.equal(detail.result, null);
        assert.equal((await service.handle('list', {})).runs[0].status, 'failed');
      });
    }
  }
});

test('saved verdicts are not trusted after evidence becomes incomplete or inconsistent', async (t) => {
  for (const type of ['verify', 'repair']) {
    await t.test(type, async (subtest) => {
      const { service, dataRoot } = await fixture(subtest, {
        verify: async ({ outputDir }) => evidence(outputDir), repair: async ({ outputDir }) => repairEvidence(outputDir),
      });
      const { job } = await service.handle('run', type === 'verify' ? request : { type });
      await service.close();
      assert.equal((await service.handle('detail', { id: job.id })).job.status, 'finished');
      const outputDir = path.join(dataRoot, 'verifier', job.id, 'artifacts');
      const primary = type === 'verify' ? 'evidence.json' : 'summary.json';
      for (const [name, invalid] of invalidResults(type, outputDir)) {
        await writeFile(path.join(outputDir, primary), JSON.stringify(invalid));
        const detail = await service.handle('detail', { id: job.id });
        assert.equal(detail.job.status, 'failed', name);
        assert.equal(detail.job.verdict, 'unverified', name);
        assert.equal(detail.result, null, name);
      }
      const changedVerdict = type === 'verify'
        ? evidenceRecord(outputDir, { verdict: { kind: 'observed_honest_failure', reason: 'A different recorded verdict.' } })
        : repairRecord(outputDir, false);
      await writeFile(path.join(outputDir, primary), JSON.stringify(changedVerdict));
      const detail = await service.handle('detail', { id: job.id });
      assert.equal(detail.job.status, 'failed');
      assert.equal(detail.job.verdict, 'unverified');
      assert.equal(detail.result, null);
    });
  }
});

test('orphan run directories do not break listing or startup and never appear as saved jobs', async (t) => {
  const { service, dataRoot } = await fixture(t, { verify: async ({ outputDir }) => evidence(outputDir) });
  const { job } = await service.handle('run', request);
  await service.close();
  const orphan = randomUUID();
  const orphanRoot = path.join(dataRoot, 'verifier', orphan);
  await mkdir(orphanRoot);
  await writeFile(path.join(orphanRoot, 'receipt-incomplete.tmp'), '{');
  await evidence(path.join(orphanRoot, 'artifacts'));
  const beforeRestart = await service.handle('list', {});
  assert.deepEqual(beforeRestart.runs.map((run) => run.id), [job.id]);
  await assert.rejects(service.handle('detail', { id: orphan }), { code: 'ENOENT' });
  await assert.rejects(service.artifact(orphan, 'evidence.json'), { code: 'ENOENT' });
  const restarted = await createVerifierService({ dataRoot });
  t.after(() => restarted.close());
  assert.deepEqual((await restarted.handle('list', {})).runs.map((run) => run.id), [job.id]);
  assert.equal((await restarted.handle('detail', { id: job.id })).job.status, 'finished');
  await assert.rejects(restarted.handle('detail', { id: orphan }), { code: 'ENOENT' });
});

test('another service cannot interrupt a running job still owned by a live process', async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { service, dataRoot } = await fixture(t, { verify: async ({ outputDir }) => { await gate.promise; await evidence(outputDir); } });
  const { job } = await service.handle('run', request);
  await assert.rejects(createVerifierService({ dataRoot }), /still owns a running job/);
  const detail = await service.handle('detail', { id: job.id });
  assert.equal(detail.job.status, 'running');
  assert.equal((await service.handle('list', {})).activeId, job.id);
  gate.resolve();
  await service.close();
  assert.equal((await service.handle('detail', { id: job.id })).job.status, 'finished');
});

test('active jobs conflict and close waits for the final persisted receipt', async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { service } = await fixture(t, { verify: async ({ outputDir }) => { await gate.promise; await evidence(outputDir); } });
  const { job } = await service.handle('run', request);
  assert.equal((await service.handle('list', {})).activeId, job.id);
  await assert.rejects(service.handle('run', request), { statusCode: 409 });
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  await assert.rejects(service.handle('run', request), { statusCode: 409 });
  gate.resolve();
  await closing;
  assert.equal((await service.handle('detail', { id: job.id })).job.status, 'finished');
  assert.equal((await service.handle('list', {})).activeId, null);
  await service.close();
});

test('close includes accepted jobs that are still publishing their initial receipt', async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const { service } = await fixture(t, { verify: async ({ outputDir }) => { await gate.promise; await evidence(outputDir); } });
  const accepting = service.handle('run', request);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  const { job } = await accepting;
  await nextTurn();
  const prematurelyClosed = closed;
  gate.resolve();
  await closing;
  await completed(service, job.id);
  assert.equal(prematurelyClosed, false, 'Shutdown must include accepted jobs still publishing their initial receipt.');
});

test('validation rejects arbitrary execution options, paths, samples, and scenarios', async (t) => {
  let executed = false;
  const { service } = await fixture(t, { verify: () => { executed = true; }, repair: () => { executed = true; } });
  for (const input of [
    null, [], {}, { ...request, app: 'arbitrary-app' }, { ...request, scenario: 'arbitrary-scenario' },
    { ...request, outputDir: '/tmp/escape' }, { ...request, appEntry: '/tmp/code.js' },
    { ...request, command: 'echo test' }, { ...request, type: 'shell' },
    { ...request, prompt: '' }, { ...request, prompt: '   ' }, { ...request, prompt: 3 },
    { ...request, prompt: 'x'.repeat(4001) }, { type: 'repair', app: 'fake-fallback' },
    { type: 'repair', prompt: 'Override fixed regression' },
  ]) await assert.rejects(service.handle('run', input));
  await assert.rejects(service.handle('list', { root: '/tmp' }));
  await assert.rejects(service.handle('detail', { id: randomUUID(), path: '/tmp' }));
  await assert.rejects(service.handle('detail', { id: '../job' }));
  await assert.rejects(service.handle('unknown', {}));
  assert.equal(executed, false);
  assert.deepEqual(await service.handle('list', {}), { runs: [], activeId: null });
});

test('restart marks persisted running jobs interrupted while preserving completed evidence', async (t) => {
  const { dataRoot, service } = await fixture(t, { verify: async ({ outputDir }) => evidence(outputDir) });
  const { job } = await service.handle('run', request);
  await service.close();
  const interruptedId = randomUUID();
  await mkdir(path.join(dataRoot, 'verifier', interruptedId));
  await writeFile(path.join(dataRoot, 'verifier', interruptedId, 'job.json'), JSON.stringify({
    id: interruptedId, type: 'verify', input: request, status: 'running', startedAt: new Date().toISOString(), liveInferenceVerified: false,
  }));
  const restarted = await createVerifierService({ dataRoot });
  t.after(() => restarted.close());
  const listing = await restarted.handle('list', {});
  const interrupted = listing.runs.find((run) => run.id === interruptedId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.liveInferenceVerified, false);
  assert.ok(Number.isFinite(Date.parse(interrupted.finishedAt)));
  assert.equal(listing.activeId, null);
  assert.equal((await restarted.handle('detail', { id: job.id })).job.status, 'finished');
  assert.equal(JSON.parse((await restarted.artifact(job.id, 'evidence.json')).toString()).liveInferenceVerified, false);
  const disk = JSON.parse(await readFile(path.join(dataRoot, 'verifier', interruptedId, 'job.json'), 'utf8'));
  assert.equal(disk.status, 'interrupted');
});

test('artifacts are limited to known run files and reject traversal and symlinks', async (t) => {
  const { dataRoot, service } = await fixture(t, { verify: async ({ outputDir }) => {
    await evidence(outputDir);
    await writeFile(path.join(outputDir, 'private.txt'), 'Private execution file');
    await writeFile(path.join(outputDir, 'app.log'), 'Safe log');
  } });
  const { job } = await service.handle('run', request);
  await service.close();
  for (const file of ['private.txt', '../job.json', '../../secret', '/etc/passwd', 'before/../../job.json', 'job.json', 'evidence.json/extra']) {
    await assert.rejects(service.artifact(job.id, file), /Unknown run artifact/);
  }
  await assert.rejects(service.artifact('../escape', 'evidence.json'), /Unknown run artifact/);
  assert.ok(!(await service.handle('detail', { id: job.id })).artifacts.some((file) => file.name === 'private.txt'));
  const outside = path.join(dataRoot, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'app.log'), 'OUTSIDE PRIVATE DATA');
  await writeFile(path.join(outside, 'workflow.png'), 'OUTSIDE IMAGE');
  const artifactRoot = path.join(dataRoot, 'verifier', job.id, 'artifacts');
  await rm(path.join(artifactRoot, 'app.log'));
  await symlink(path.join(outside, 'app.log'), path.join(artifactRoot, 'app.log'));
  await mkdir(path.join(artifactRoot, 'before'));
  await symlink(outside, path.join(artifactRoot, 'before', 'provider-fail'));
  await assert.rejects(service.artifact(job.id, 'app.log'), /[Ss]ymbolic link/);
  await assert.rejects(service.artifact(job.id, 'before/provider-fail/workflow.png'), /[Ss]ymbolic link/);
  const listing = await service.handle('detail', { id: job.id });
  assert.ok(!listing.artifacts.some((file) => file.name === 'app.log'));
  assert.ok(!listing.artifacts.some((file) => file.name.startsWith('before/provider-fail/')));
});


test('primary byte integrity rejects same-verdict replacements and unbound legacy receipts for both run types', async (t) => {
  for (const type of ['verify', 'repair']) await t.test(type, async (subtest) => {
    const { service, dataRoot } = await fixture(subtest, {
      verify: async ({ outputDir }) => evidence(outputDir),
      repair: async ({ outputDir }) => repairEvidence(outputDir),
    });
    const { job } = await service.handle('run', type === 'verify' ? request : { type });
    await service.close();
    const primary = path.join(dataRoot, 'verifier', job.id, 'artifacts', type === 'verify' ? 'evidence.json' : 'summary.json');
    const bytes = await readFile(primary);
    const changed = JSON.parse(bytes);
    if (type === 'verify') changed.verdict.reason = 'A different but still shape-valid reason.';
    else changed.scenarios[0].before.reason = 'A different but still shape-valid reason.';
    await writeFile(primary, JSON.stringify(changed));
    const detail = await service.handle('detail', { id: job.id });
    assert.equal(detail.result, null);
    assert.equal(detail.job.evidenceIntegrity, 'changed');
    assert.equal(detail.job.verdict, 'unverified');
    await writeFile(primary, bytes);
    assert.equal((await service.handle('detail', { id: job.id })).job.status, 'finished');
    const receiptPath = path.join(dataRoot, 'verifier', job.id, 'job.json');
    const legacy = JSON.parse(await readFile(receiptPath, 'utf8'));
    delete legacy.primaryArtifactSha256;
    await writeFile(receiptPath, JSON.stringify(legacy));
    const unbound = await service.handle('detail', { id: job.id });
    assert.equal(unbound.job.evidenceIntegrity, 'unbound');
    assert.equal(unbound.result, null);
    assert.equal(unbound.job.verdict, 'unverified');
  });
});
