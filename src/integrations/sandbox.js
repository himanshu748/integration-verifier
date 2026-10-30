import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreeUsageGuard } from './freeUsage.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const SANDBOX_BUNDLE_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'src/sample-apps/server.js',
  ...['run', 'replay', 'judge', 'contract', 'repair', 'boundary', 'browserWorkflow', 'sampleProcess', 'regressionProcess'].map((name) => `src/verifier/${name}.js`),
  'scripts/sandbox_candidate_runner.mjs',
]);
const scenarios = ['provider-fail', 'malformed', 'marker'];
export const SANDBOX_ARTIFACTS = Object.freeze([
  'evidence.json', 'summary.json', 'failure.json', 'repair.patch', 'regression.test.mjs', 'workflow.png', 'browser-trace.zip', 'app.log', 'app.before.js', 'app.after.js',
  ...['before', 'after'].flatMap((phase) => [`${phase}/regression.log`, ...scenarios.flatMap((scenario) =>
    ['evidence.json', 'workflow.png', 'browser-trace.zip', 'app.log', 'repair.patch'].map((file) => `${phase}/${scenario}/${file}`))]),
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const DEFAULT_SANDBOX_IMAGE = 'docker://docker.io/library/node:22-bookworm';

export async function sandboxBundleManifest() {
  return Promise.all(SANDBOX_BUNDLE_FILES.map(async (name) => {
    const location = path.join(root, name);
    if (!(await lstat(location)).isFile()) throw new Error('Sandbox bundle contains an unavailable source file.');
    const bytes = await readFile(location);
    if (bytes.length > 1024 * 1024) throw new Error('Sandbox source file exceeds its size limit.');
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  }));
}

function executePython(payload, env) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-B', path.join(root, 'scripts/nebius_sandbox.py')], {
      env, timeout: 25 * 60 * 1000, maxBuffer: 128 * 1024, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error) return reject(new Error('Sandbox runner failed. Check Sandbox access, project configuration, and the pinned Python dependency.'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Sandbox runner returned an invalid receipt.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export function sandboxConfiguration(env = process.env) {
  return { configured: Boolean(env.NEBIUS_API_KEY && env.NEBIUS_PROJECT_ID),
    image: env.NEBIUS_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE };
}

export async function runSandboxVerification(input, { env = process.env, executor = executePython } = {}) {
  if (!input || Object.keys(input).some((key) => !['type', 'app', 'scenario', 'prompt', 'outputDir', 'candidateSource'].includes(key))) throw new Error('Unsupported sandbox request.');
  if (!['verify', 'repair'].includes(input.type)) throw new Error('Choose verification or repair.');
  if (input.type === 'verify' && (!['fake-fallback', 'honest-live', 'declared-fallback'].includes(input.app) || !scenarios.includes(input.scenario))) throw new Error('Choose a supported sample and scenario.');
  if (input.prompt !== undefined && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000)) throw new Error('Invalid sandbox prompt.');
  if (input.candidateSource !== undefined && (input.type !== 'repair' || typeof input.candidateSource !== 'string' || !input.candidateSource.trim() || Buffer.byteLength(input.candidateSource) > 256 * 1024)) throw new Error('Candidate source is supported only for bounded repair runs.');
  if (typeof input.outputDir !== 'string' || !path.isAbsolute(input.outputDir)) throw new Error('Sandbox output must be an absolute new directory.');
  if (!env.NEBIUS_API_KEY || !env.NEBIUS_PROJECT_ID) throw new Error('Configure NEBIUS_API_KEY and NEBIUS_PROJECT_ID for Sandbox access.');
  const image = env.NEBIUS_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  if (!/^docker:\/\/[a-zA-Z0-9][a-zA-Z0-9._/:@-]{1,250}$/.test(image)) throw new Error('Sandbox image must be an OCI docker reference.');
  const manifest = await sandboxBundleManifest();
  const files = await Promise.all(manifest.map(async (entry) => {
    const bytes = await readFile(path.join(root, entry.path));
    if (digest(bytes) !== entry.sha256) throw new Error('Sandbox bundle changed while preparing the run.');
    return { ...entry, content: bytes.toString('base64') };
  }));
  await mkdir(path.dirname(input.outputDir), { recursive: true });
  await mkdir(input.outputDir, { mode: 0o700 }); // Exclusive: never reuse or overwrite prior evidence.
  await writeFile(path.join(input.outputDir, 'bundle-manifest.json'), JSON.stringify({ files: manifest }, null, 2), { flag: 'wx', mode: 0o600 });
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'NEBIUS_API_KEY', 'NEBIUS_PROJECT_ID'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  const payload = { version: 1, image, outputDir: input.outputDir, files, artifacts: SANDBOX_ARTIFACTS,
    request: { type: input.type, app: input.app, scenario: input.scenario, prompt: input.prompt, candidateSource: input.candidateSource } };
  const freeUsage = executor === executePython
    ? await createFreeUsageGuard({ provider: 'nebius-sandbox', env }).reserve({ operation: 'sandbox-verification' }) : null;
  let remote;
  try { remote = await executor(payload, childEnv); }
  catch { throw new Error('Sandbox execution or evidence retrieval failed; no verified Sandbox receipt was produced.'); }
  const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
  if (!remote || !validId(remote.executionId) || !validId(remote.image) ||
      (remote.setupImage !== undefined && !validId(remote.setupImage)) ||
      !Number.isInteger(remote.exitCode) || remote.exitCode < 0 || remote.exitCode > 255) throw new Error('Sandbox execution returned an incomplete receipt.');
  const artifactHashes = { 'bundle-manifest.json': digest(await readFile(path.join(input.outputDir, 'bundle-manifest.json'))) };
  let totalBytes = 0;
  for (const file of SANDBOX_ARTIFACTS) {
    try {
      const location = path.join(input.outputDir, file);
      let current = input.outputDir;
      for (const part of file.split('/')) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('Unsafe Sandbox artifact.'); }
      const info = await lstat(location);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid Sandbox artifact.');
      totalBytes += info.size;
      if (totalBytes > 128 * 1024 * 1024) throw new Error('Sandbox artifacts exceed their total size limit.');
      artifactHashes[file] = digest(await readFile(location));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const primary = input.type === 'repair' ? 'summary.json' : 'evidence.json';
  if (!artifactHashes[primary]) throw new Error('Sandbox execution did not return its required evidence.');
  let evidence;
  try { evidence = JSON.parse(await readFile(path.join(input.outputDir, primary), 'utf8')); } catch { throw new Error('Sandbox evidence is malformed.'); }
  if (!evidence || evidence.liveInferenceVerified !== false || evidence.evidenceScope !== 'local-controlled-provider') throw new Error('Sandbox evidence has an invalid verification scope.');
  const expectedExit = input.type === 'repair'
    ? { verified_local_repair: 0, not_verified: 3 }[evidence.status]
    : { observed_controlled_path: 0, observed_honest_failure: 0, contract_violation: 2, unverified: 3 }[evidence.verdict?.kind];
  if (expectedExit === undefined || remote.exitCode !== expectedExit) throw new Error('Sandbox exit status does not match its evidence.');
  const liveSandboxVerified = executor === executePython;
  const receipt = { version: 1, provider: 'nebius-token-factory-sandboxes',
    transport: liveSandboxVerified ? 'nebius-token-factory-sandboxes' : 'test-fixture',
    liveSandboxVerified, status: liveSandboxVerified ? 'verified' : 'fixture-verified', executionId: remote.executionId,
    image: remote.image, baseImage: image, setupImage: remote.setupImage ?? null, exitCode: remote.exitCode,
    artifactHashes, bundle: manifest, ...(input.candidateSource ? { candidateSourceSha256: digest(input.candidateSource) } : {}),
    recordedAt: new Date().toISOString(), liveInferenceVerified: false, freeUsage };
  await writeFile(path.join(input.outputDir, 'sandbox.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  return { outputDir: input.outputDir, receipt };
}
