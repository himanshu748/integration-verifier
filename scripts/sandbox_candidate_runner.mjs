// Executed only inside the Token Factory Sandbox. Never import candidate code here.
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runVerification, sampleAppEntry, sha256 } from '../src/verifier/run.js';
import { runRepairReplay } from '../src/verifier/replay.js';
import { executeRegression } from '../src/verifier/regressionProcess.js';

const outputDir = '/output';
const scenarios = ['provider-fail', 'malformed', 'marker'];
const regressionSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runVerification } from '/workspace/src/verifier/run.js';
for (const scenario of ['provider-fail', 'malformed', 'marker']) {
  test(scenario + ' preserves the integration contract', async () => {
    const { evidence } = await runVerification({ app: 'fake-fallback', scenario,
      appEntry: process.env.VERIFIER_APP_ENTRY,
      executionUser: { uid: 65534, gid: 65534 },
      outputDir: path.join(process.env.VERIFIER_EVIDENCE_DIR, scenario) });
    assert.equal(evidence.verdict.kind, scenario === 'marker' ? 'observed_controlled_path' : 'observed_honest_failure');
    assert.equal(evidence.liveInferenceVerified, false);
  });
}
`;
async function moduleHashes() {
  const manifest = JSON.parse(await readFile('/workspace/bundle-manifest.json', 'utf8'));
  const hashes = {};
  for (const entry of manifest.files) {
    const filename = path.join('/workspace', entry.path);
    const stat = await lstat(filename);
    assert.ok(stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'Immutable source must be root-owned and read-only to the candidate.');
    hashes[entry.path] = sha256(await readFile(filename));
    assert.equal(hashes[entry.path], entry.sha256, 'Immutable source differs from the uploaded bundle manifest.');
  }
  return hashes;
}
async function candidateRepair() {
  const candidateEntry = '/candidate/server.js';
  const original = await readFile(sampleAppEntry);
  const candidate = await readFile(candidateEntry);
  const originalHashes = await moduleHashes();
  await writeFile(path.join(outputDir, 'app.before.js'), original, { flag: 'wx' });
  await writeFile(path.join(outputDir, 'app.after.js'), candidate, { flag: 'wx' });
  const testPath = path.join(outputDir, 'regression.test.mjs');
  await writeFile(testPath, regressionSource, { flag: 'wx', mode: 0o444 });
  async function regression(phase, appEntry) {
    const evidenceDir = path.join(outputDir, phase);
    await mkdir(evidenceDir, { mode: 0o700 });
    const result = await executeRegression({ testPath, timeoutMs: 150000,
      env: { PATH: process.env.PATH, HOME: '/root', TMPDIR: '/tmp', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
        VERIFIER_APP_ENTRY: appEntry, VERIFIER_EVIDENCE_DIR: evidenceDir } });
    const logPath = path.join(evidenceDir, 'regression.log');
    await writeFile(logPath, result.stdout + result.stderr, { flag: 'wx' });
    const evidence = await Promise.all(scenarios.map(async (scenario) => JSON.parse(await readFile(path.join(evidenceDir, scenario, 'evidence.json'), 'utf8'))));
    return { exitCode: result.exitCode, logPath, evidence };
  }
  const before = await regression('before', sampleAppEntry);
  assert.equal(before.exitCode, 1, 'The untouched regression must fail on the original sample.');
  assert.ok(before.evidence.slice(0, 2).every((entry) => entry.verdict.kind === 'contract_violation'));
  assert.equal(before.evidence[2].verdict.kind, 'observed_controlled_path');
  const after = await regression('after', candidateEntry);
  const unchangedModules = JSON.stringify(originalHashes) === JSON.stringify(await moduleHashes());
  const checks = {
    regressionFailedBefore: before.exitCode === 1, regressionPassedAfter: after.exitCode === 0,
    failuresExposedBefore: before.evidence.slice(0, 2).every((entry) => entry.verdict.kind === 'contract_violation'),
    failuresDisclosedAfter: after.evidence.slice(0, 2).every((entry) => entry.verdict.kind === 'observed_honest_failure'),
    successfulPathPreserved: [before.evidence[2], after.evidence[2]].every((entry) => entry.verdict.kind === 'observed_controlled_path'),
    sourceEvidenceMatches: before.evidence.every((entry) => entry.sourceSha256 === sha256(original)) && after.evidence.every((entry) => entry.sourceSha256 === sha256(candidate)),
    unchangedContract: new Set([...before.evidence, ...after.evidence].map((entry) => entry.contractSha256)).size === 1 && unchangedModules,
    unchangedRegression: (await readFile(testPath, 'utf8')) === regressionSource && unchangedModules,
    originalSourceUnchanged: sha256(await readFile(sampleAppEntry)) === sha256(original),
  };
  const summary = { status: Object.values(checks).every(Boolean) ? 'verified_local_repair' : 'not_verified', generatedAt: new Date().toISOString(),
    repairSource: 'nemotron-generated', evidenceScope: 'local-controlled-provider', liveInferenceVerified: false,
    regressionSha256: sha256(regressionSource), contractSha256: before.evidence[0].contractSha256,
    originalSourceSha256: sha256(original), repairedSourceSha256: sha256(candidate), immutableModuleHashes: originalHashes,
    checks, before: { exitCode: before.exitCode, logPath: before.logPath }, after: { exitCode: after.exitCode, logPath: after.logPath },
    scenarios: scenarios.map((scenario, index) => ({ scenario, before: before.evidence[index].verdict, after: after.evidence[index].verdict,
      beforeEvidence: `before/${scenario}/evidence.json`, afterEvidence: `after/${scenario}/evidence.json` })) };
  await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary), { flag: 'wx' });
  return summary.status === 'verified_local_repair' ? 0 : 3;
}

try {
  assert.equal(process.getuid(), 0, 'The verifier harness must run as root and drop candidate privileges.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // For deterministic replay outputDir must not exist yet; candidate mode creates it here.
  if (request.type === 'repair' && !request.hasCandidate) {
    const { summary } = await runRepairReplay({ outputDir });
    process.exitCode = summary.status === 'verified_local_repair' ? 0 : 3;
  } else if (request.type === 'repair') {
    await mkdir(outputDir, { mode: 0o700 });
    process.exitCode = await candidateRepair();
  } else {
    const { evidence } = await runVerification({ app: request.app, scenario: request.scenario, prompt: request.prompt, outputDir });
    process.exitCode = evidence.verdict.kind === 'unverified' ? 3 : evidence.verdict.kind === 'contract_violation' ? 2 : 0;
  }
} catch {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(outputDir, 'failure.json'), JSON.stringify({ status: 'not_verified', liveInferenceVerified: false,
    evidenceScope: 'local-controlled-provider', reason: 'Remote verifier or fixed regression could not complete.' }), { flag: 'wx' }).catch(() => {});
  process.exitCode = 1;
}
