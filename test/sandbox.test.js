import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_ARTIFACTS, SANDBOX_BUNDLE_FILES, runSandboxVerification,
  sandboxBundleManifest, sandboxConfiguration } from '../src/integrations/sandbox.js';
import { runVerification } from '../src/verifier/run.js';
import { startSampleProcess, validateExecutionUser } from '../src/verifier/sampleProcess.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(),
  NEBIUS_API_KEY: 'local-fixture-key-not-a-credential', NEBIUS_PROJECT_ID: 'local-fixture-project',
  OTHER_SECRET: 'must-not-be-forwarded', NODE_OPTIONS: '--inspect', PYTHONPATH: '/untrusted' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const request = { type: 'verify', app: 'fake-fallback', scenario: 'provider-fail' };
// Transport fixture only: deliberately not a claim of browser or provider execution.
const scopedEvidence = { evidenceScope: 'local-controlled-provider', liveInferenceVerified: false,
  verdict: { kind: 'contract_violation', reason: 'Offline adapter fixture.' } };
const remote = { executionId: 'offline-fixture-operation', image: 'offline-fixture-checkpoint',
  setupImage: 'offline-fixture-runtime', exitCode: 2 };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sandbox-offline-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, outputDir: path.join(directory, 'output') };
}
async function fakeExecutor(payload) {
  const repair = payload.request.type === 'repair';
  await writeFile(path.join(payload.outputDir, repair ? 'summary.json' : 'evidence.json'), JSON.stringify({ ...scopedEvidence, ...(repair ? { status: 'not_verified' } : {}) }));
  return { ...remote, exitCode: repair ? 3 : 2 };
}

test('bundle manifest allows only reviewable verifier files and hashes their current bytes', async () => {
  const manifest = await sandboxBundleManifest();
  assert.deepEqual(manifest.map((entry) => entry.path), [...SANDBOX_BUNDLE_FILES]);
  assert.equal(new Set(manifest.map((entry) => entry.path)).size, manifest.length);
  for (const entry of manifest) {
    assert.doesNotMatch(entry.path, /(?:^|\/)(?:\.env|work|test|node_modules|\.git)(?:\/|$)/);
    const bytes = await readFile(path.join(root, entry.path));
    assert.equal(entry.sha256, hash(bytes));
    assert.equal(entry.bytes, bytes.length);
  }
  assert.ok(manifest.some((entry) => entry.path === 'scripts/sandbox_candidate_runner.mjs'));
});

test('offline transport saves hashed evidence, excludes unrelated secrets, and cannot claim live Sandbox', async (t) => {
  const { outputDir } = await temporary(t);
  let payloadSeen;
  const { receipt } = await runSandboxVerification({ ...request, outputDir }, { env, executor: async (payload, childEnv) => {
    payloadSeen = payload;
    assert.deepEqual(Object.keys(childEnv).sort(), ['HOME', 'NEBIUS_API_KEY', 'NEBIUS_PROJECT_ID', 'PATH', 'TMPDIR']);
    assert.equal(childEnv.NEBIUS_API_KEY, env.NEBIUS_API_KEY);
    assert.ok(!JSON.stringify(payload).includes(env.NEBIUS_API_KEY));
    assert.equal(payload.image, DEFAULT_SANDBOX_IMAGE);
    assert.deepEqual(payload.artifacts, SANDBOX_ARTIFACTS);
    for (const entry of payload.files) assert.equal(hash(Buffer.from(entry.content, 'base64')), entry.sha256);
    await fakeExecutor(payload);
    await writeFile(path.join(outputDir, 'app.log'), 'offline adapter fixture log');
    await writeFile(path.join(outputDir, '.env'), 'unlisted output must not be receipted');
    return { ...remote, status: 'verified', liveSandboxVerified: true };
  } });
  assert.equal(receipt.transport, 'test-fixture');
  assert.equal(receipt.status, 'fixture-verified');
  assert.equal(receipt.liveSandboxVerified, false);
  assert.equal(receipt.liveInferenceVerified, false);
  assert.equal(receipt.exitCode, 2); // Cloud execution proof and app verdict are distinct.
  assert.equal(receipt.artifactHashes['evidence.json'], hash(await readFile(path.join(outputDir, 'evidence.json'))));
  assert.equal(receipt.artifactHashes['bundle-manifest.json'], hash(await readFile(path.join(outputDir, 'bundle-manifest.json'))));
  assert.equal(receipt.artifactHashes['app.log'], hash('offline adapter fixture log'));
  assert.equal(receipt.artifactHashes['.env'], undefined);
  assert.equal(receipt.bundle.length, payloadSeen.files.length);
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, 'sandbox.json'), 'utf8')), receipt);
  assert.deepEqual(sandboxConfiguration(env), { configured: true, image: DEFAULT_SANDBOX_IMAGE });
  assert.equal(sandboxConfiguration({}).configured, false);
});

test('candidate remains inert text, is separately bound by hash, and preserves the immutable bundle', async (t) => {
  const { directory, outputDir } = await temporary(t);
  const marker = path.join(directory, 'candidate-must-never-run');
  const candidateSource = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe');`;
  const originalHash = hash(await readFile(path.join(root, 'src/sample-apps/server.js')));
  const { receipt } = await runSandboxVerification({ type: 'repair', outputDir, candidateSource }, { env, executor: async (payload) => {
    assert.equal(payload.request.candidateSource, candidateSource);
    assert.ok(payload.files.every((entry) => !entry.path.startsWith('candidate/')));
    assert.equal(payload.files.find((entry) => entry.path === 'src/sample-apps/server.js').sha256, originalHash);
    return fakeExecutor(payload);
  } });
  assert.equal(receipt.candidateSourceSha256, hash(candidateSource));
  assert.equal(hash(await readFile(path.join(root, 'src/sample-apps/server.js'))), originalHash);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('invalid requests fail before executor invocation or output creation', async (t) => {
  const { outputDir } = await temporary(t);
  let called = false;
  const options = { env, executor: async () => { called = true; return remote; } };
  const bad = [null, { ...request, extra: true }, { ...request, type: 'shell' }, { ...request, app: '../../.env' },
    { ...request, scenario: 'live' }, { ...request, candidateSource: 'process.exit()' },
    { type: 'repair', candidateSource: 'x'.repeat(256 * 1024 + 1) }, { ...request, prompt: '' }];
  for (const input of bad) await assert.rejects(runSandboxVerification(input && { ...input, outputDir }, options));
  await assert.rejects(runSandboxVerification({ ...request, outputDir: 'relative' }, options));
  await assert.rejects(runSandboxVerification({ ...request, outputDir }, { ...options, env: {} }), /Configure/);
  await assert.rejects(runSandboxVerification({ ...request, outputDir }, { ...options, env: { ...env, NEBIUS_SANDBOX_IMAGE: 'sh; evil' } }), /OCI/);
  assert.equal(called, false);
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
});

test('existing output cannot be overwritten or submitted', async (t) => {
  const { outputDir } = await temporary(t);
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, 'evidence.json'), 'previous evidence');
  let called = false;
  await assert.rejects(runSandboxVerification({ ...request, outputDir }, { env, executor: async () => { called = true; } }), { code: 'EEXIST' });
  assert.equal(called, false);
  assert.equal(await readFile(path.join(outputDir, 'evidence.json'), 'utf8'), 'previous evidence');
});

test('missing, malformed, mis-scoped, linked evidence and malformed remote IDs never produce a receipt', async (t) => {
  const cases = [
    ['missing evidence', async () => remote],
    ['malformed JSON', async (p) => { await writeFile(path.join(p.outputDir, 'evidence.json'), '{'); return remote; }],
    ['false live claim', async (p) => { await writeFile(path.join(p.outputDir, 'evidence.json'), JSON.stringify({ ...scopedEvidence, liveInferenceVerified: true })); return remote; }],
    ['linked artifact', async (p) => { await fakeExecutor(p); await symlink(path.join(p.outputDir, 'evidence.json'), path.join(p.outputDir, 'app.log')); return remote; }],
    ['linked directory', async (p) => { await fakeExecutor(p); await symlink(p.outputDir, path.join(p.outputDir, 'before')); return remote; }],
    ['unbounded ID', async (p) => { await fakeExecutor(p); return { ...remote, executionId: 'x'.repeat(1000) }; }],
    ['unsafe ID', async (p) => { await fakeExecutor(p); return { ...remote, image: '../secret' }; }],
    ['killed process with passing evidence', async (p) => {
      await writeFile(path.join(p.outputDir, 'evidence.json'), JSON.stringify({ ...scopedEvidence,
        verdict: { kind: 'observed_controlled_path', reason: 'Offline passing adapter fixture.' } }));
      return { ...remote, exitCode: 137 };
    }],
  ];
  for (const [name, executor] of cases) await t.test(name, async (st) => {
    const { outputDir } = await temporary(st);
    await assert.rejects(runSandboxVerification({ ...request, outputDir }, { env, executor }));
    await assert.rejects(access(path.join(outputDir, 'sandbox.json')), { code: 'ENOENT' });
  });
});

test('provider errors are sanitized before returning to the caller', async (t) => {
  const { outputDir } = await temporary(t);
  await assert.rejects(runSandboxVerification({ ...request, outputDir }, { env, executor: async () => {
    throw new Error(`Authorization: Bearer ${env.NEBIUS_API_KEY}`);
  } }), (error) => !error.message.includes(env.NEBIUS_API_KEY) && /no verified Sandbox receipt/.test(error.message));
});

test('root or malformed execution identity is rejected before starting an app or browser', async () => {
  for (const executionUser of [null, {}, { uid: 0, gid: 0 }, { uid: 65534, gid: 0 },
    { uid: -1, gid: 1 }, { uid: 1.5, gid: 1 }, { uid: 2 ** 32, gid: 1 }, { uid: 1, gid: 1, extra: true }]) {
    assert.throws(() => validateExecutionUser(executionUser), /positive uid and gid/);
    await assert.rejects(startSampleProcess({ executionUser }), /positive uid and gid/);
    await assert.rejects(runVerification({ executionUser, appEntry: '/nonexistent' }), /positive uid and gid/);
  }
  assert.doesNotThrow(() => validateExecutionUser({ uid: 65534, gid: 65534 }));
  assert.doesNotThrow(() => validateExecutionUser(undefined));
});

test('Python adapter contract passes entirely through an explicit offline SDK fixture', async () => {
  const { stdout, stderr } = await execute('python3', ['-B', path.join(root, 'test/sandbox_adapter_test.py')], {
    timeout: 15000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir() },
  });
  assert.match(stdout + stderr, /OK/);
});
