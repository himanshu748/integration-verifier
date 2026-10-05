import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runVerification } from './run.js';
import { runRepairReplay } from './replay.js';
import { isValidContract } from './contract.js';
import { runSandboxVerification, sandboxBundleManifest } from '../integrations/sandbox.js';
import { generateRepairCandidate } from './modelRepair.js';
import { sha256 } from './run.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPS = ['fake-fallback', 'honest-live', 'declared-fallback'];
const SCENARIOS = ['provider-fail', 'malformed', 'marker'];
const VERDICTS = ['contract_violation', 'observed_controlled_path', 'observed_honest_failure', 'unverified'];
const REPAIR_CHECKS = ['regressionFailedBefore', 'regressionPassedAfter', 'failuresExposedBefore', 'failuresDisclosedAfter', 'successfulPathPreserved', 'sourceEvidenceMatches', 'unchangedContract', 'unchangedRegression', 'originalSourceUnchanged'];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.trim().length > 0;
const date = (value) => string(value) && Number.isFinite(Date.parse(value));
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const verdict = (value) => record(value) && VERDICTS.includes(value.kind) && string(value.reason);

function validResult(result, job) {
  if (!record(result) || result.liveInferenceVerified !== false || result.evidenceScope !== 'local-controlled-provider') return false;
  if (job.type === 'verify') {
    const observed = result.observations;
    return result.verifierVersion === '0.2.0' && date(result.startedAt) && date(result.completedAt) &&
      result.app === job.input.app && result.scenario === job.input.scenario &&
      hash(result.sourceSha256) && hash(result.contractSha256) && isValidContract(result.contract) && verdict(result.verdict) &&
      record(observed) && typeof observed.pageLoaded === 'boolean' &&
      Number.isInteger(observed.workflowStatus) && observed.workflowStatus >= 100 && observed.workflowStatus <= 599 &&
      record(observed.workflowBody) && Array.isArray(observed.providerRequests) &&
      Array.isArray(observed.browserRequests) && Array.isArray(observed.browserResponses) &&
      string(observed.syntheticMarker) && string(observed.screenshotPath) && string(observed.tracePath) &&
      (job.status !== 'finished' || job.verdict === result.verdict.kind);
  }
  const checks = result.checks;
  if (!record(checks) || REPAIR_CHECKS.some((key) => typeof checks[key] !== 'boolean')) return false;
  const passed = REPAIR_CHECKS.every((key) => checks[key]);
  const processResult = (value) => record(value) && Number.isInteger(value.exitCode) && string(value.logPath);
  return result.status === (passed ? 'verified_local_repair' : 'not_verified') &&
    result.repairSource === (job.input.repairMode === 'nemotron' ? 'nemotron-generated' : 'deterministic-local-template') && date(result.generatedAt) &&
    ['regressionSha256', 'contractSha256', 'originalSourceSha256', 'repairedSourceSha256'].every((key) => hash(result[key])) &&
    processResult(result.before) && processResult(result.after) &&
    (!passed || (result.before.exitCode === 1 && result.after.exitCode === 0)) &&
    Array.isArray(result.scenarios) && result.scenarios.length === SCENARIOS.length &&
    SCENARIOS.every((scenario) => result.scenarios.some((entry) => record(entry) && entry.scenario === scenario &&
      verdict(entry.before) && verdict(entry.after) && string(entry.beforeEvidence) && string(entry.afterEvidence))) &&
    (job.status !== 'finished' || job.verdict === result.status);
}
const files = ['evidence.json', 'summary.json', 'failure.json', 'repair.patch', 'regression.test.mjs', 'workflow.png', 'browser-trace.zip', 'app.log', 'app.before.js', 'app.after.js', 'sandbox.json', 'bundle-manifest.json', 'inference.json'];
const artifacts = new Set([...files, ...['before', 'after'].flatMap((phase) => [
  `${phase}/regression.log`, ...SCENARIOS.flatMap((scenario) => ['evidence.json', 'workflow.png', 'browser-trace.zip', 'app.log', 'repair.patch'].map((file) => `${phase}/${scenario}/${file}`)),
])]);

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Unsupported request fields.');
}

async function readSafe(root, relative, limit = 16 * 1024 * 1024) {
  let absolute = root;
  for (const part of relative.split('/')) {
    absolute = path.join(absolute, part);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error('Symbolic links are not available as run evidence.');
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Artifact is unavailable or exceeds the download limit.');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('Artifact changed while being read. Retry the download.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function createVerifierService({ dataRoot, verify = runVerification, repair = runRepairReplay, sandbox = runSandboxVerification, inferenceRuntime }) {
  const root = path.join(dataRoot, 'verifier');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Verifier data directory cannot be a symbolic link.');
  let active = null;
  const pending = new Set();
  let closing = false;
  async function persist(job) {
    const directory = path.join(root, job.id);
    const temporary = path.join(directory, `receipt-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(directory, 'job.json'));
  }
  async function load(id) {
    if (!ID.test(id)) throw new Error('Unknown run ID.');
    return JSON.parse(await readSafe(root, `${id}/job.json`, 64 * 1024));
  }
  async function sandboxReceipt(job, result) {
    if (job.input.execution !== 'sandbox') return null;
    const receipt = JSON.parse(await readSafe(root, `${job.id}/artifacts/sandbox.json`));
    const real = receipt.transport === 'nebius-token-factory-sandboxes' && receipt.liveSandboxVerified === true && receipt.status === 'verified';
    const fixture = receipt.transport === 'test-fixture' && receipt.liveSandboxVerified === false && receipt.status === 'fixture-verified';
    if (receipt.provider !== 'nebius-token-factory-sandboxes' || (!real && !fixture) ||
      !string(receipt.executionId) || !Number.isInteger(receipt.exitCode) || !record(receipt.artifactHashes)) throw new Error('Sandbox execution receipt is missing or invalid.');
    const primary = job.type === 'repair' ? 'summary.json' : 'evidence.json';
    const expectedExit = job.type === 'repair' ? (result.status === 'verified_local_repair' ? 0 : 3)
      : result.verdict.kind === 'contract_violation' ? 2 : result.verdict.kind === 'unverified' ? 3 : 0;
    if (receipt.exitCode !== expectedExit) throw new Error('Sandbox process exit does not match the saved verification outcome.');
    if (!hash(receipt.artifactHashes[primary])) throw new Error('Sandbox receipt does not bind the run evidence.');
    for (const [file, expected] of Object.entries(receipt.artifactHashes)) {
      if (!artifacts.has(file) || !hash(expected) || sha256(await readSafe(root, `${job.id}/artifacts/${file}`)) !== expected) throw new Error('Saved Sandbox evidence no longer matches its execution receipt.');
    }
    if (job.input.repairMode === 'nemotron' && (!hash(job.inference?.candidateSourceSha256) ||
      receipt.candidateSourceSha256 !== job.inference.candidateSourceSha256 || result.repairedSourceSha256 !== job.inference.candidateSourceSha256 ||
      result.originalSourceSha256 !== job.inference.originalSourceSha256)) throw new Error('Sandbox evidence does not match the Nemotron candidate.');
    return receipt;
  }
  async function initialReceipt(id) {
    try { return await load(id); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    const job = await initialReceipt(entry.name);
    if (!job) continue; // An interrupted first write may leave an unpublished directory.
    if (job.status === 'running') {
      if (Number.isSafeInteger(job.ownerPid) && job.ownerPid > 0) {
        try { process.kill(job.ownerPid, 0); throw new Error('Another verifier process still owns a running job in this data directory.'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await persist({ ...job, status: 'interrupted', error: 'The server stopped before this run produced a final receipt.', finishedAt: new Date().toISOString() });
    }
  }
  async function list() {
    const records = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && ID.test(entry.name)) {
        const job = await initialReceipt(entry.name);
        if (job) records.push(job);
      }
    }
    return { runs: records.sort((a, b) => b.startedAt.localeCompare(a.startedAt)), activeId: active };
  }
  async function detail(id) {
    const job = await load(id);
    const available = [];
    for (const file of artifacts) {
      try {
        let target = path.join(root, id);
        let unsafe = false;
        for (const part of ['artifacts', ...file.split('/')]) {
          target = path.join(target, part);
          if ((await lstat(target)).isSymbolicLink()) { unsafe = true; break; }
        }
        if (unsafe) continue;
        const info = await lstat(target);
        if (info.isFile()) available.push({ name: file, bytes: info.size });
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    let result = null;
    let execution = null;
    let evidenceIntegrity = 'missing';
    const primary = job.type === 'repair' ? 'summary.json' : 'evidence.json';
    if (available.some((file) => file.name === primary)) {
      try {
        const bytes = await readSafe(root, `${id}/artifacts/${primary}`);
        evidenceIntegrity = !hash(job.primaryArtifactSha256) ? 'unbound'
          : sha256(bytes) === job.primaryArtifactSha256 ? 'matched' : 'changed';
        const parsed = JSON.parse(bytes);
        // A shape-valid replacement is still different evidence. Legacy receipts
        // need a new run; they cannot silently acquire an integrity guarantee.
        if (validResult(parsed, job) && (job.status !== 'finished' || evidenceIntegrity === 'matched')) {
          execution = await sandboxReceipt(job, parsed);
          result = parsed;
        }
      }
      catch { /* Keep the failure receipt accessible when an artifact is malformed. */ }
    }
    const receipt = job.status === 'finished' && result === null
      ? { ...job, status: 'failed', verdict: 'unverified', evidenceIntegrity, error: 'Saved run evidence is missing or unreadable, has changed, lacks its integrity receipt, or has an invalid structure. The result cannot be verified. Retain this run and start a new check.' }
      : job;
    return { job: receipt, result, execution, artifacts: available };
  }
  async function run(input) {
    fields(input, ['type', 'app', 'scenario', 'prompt', 'execution', 'repairMode', 'consent']);
    if (!['verify', 'repair'].includes(input.type)) throw new Error('Choose verification or repair replay.');
    if (input.execution !== undefined && !['local', 'sandbox'].includes(input.execution)) throw new Error('Choose local or Sandbox execution.');
    const remote = input.execution === 'sandbox';
    if (remote && input.consent !== true) throw new Error('Confirm sending the reviewed bundled sample and workflow prompt to Nebius Sandboxes.');
    if (input.repairMode !== undefined && (input.repairMode !== 'nemotron' || input.type !== 'repair' || !remote)) throw new Error('Nemotron candidates may execute only in Nebius Sandboxes.');
    if (input.type === 'repair' && Object.keys(input).some((key) => !['type', 'execution', 'repairMode', 'consent'].includes(key))) throw new Error('Repair replay uses the fixed bundled sample and unchanged regression.');
    if (remote && inferenceRuntime?.status && !inferenceRuntime.status().sandboxConfigured) throw Object.assign(new Error('Sandbox access is not configured. Set NEBIUS_API_KEY and NEBIUS_PROJECT_ID after account setup.'), { statusCode: 503 });
    if (input.type === 'verify' && (!APPS.includes(input.app) || !SCENARIOS.includes(input.scenario))) throw new Error('Choose a supported sample and provider scenario.');
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000)) throw new Error('Prompt must contain between 1 and 4000 characters.');
    if (active || closing) throw Object.assign(new Error('A run is already active or the server is closing. Wait for it to finish.'), { statusCode: 409 });
    const id = randomUUID();
    active = id;
    let started;
    const startup = new Promise((resolve) => { started = resolve; });
    pending.add(startup);
    const job = { id, type: input.type, input, status: 'running', ownerPid: process.pid, startedAt: new Date().toISOString(), liveInferenceVerified: false };
    try {
      await mkdir(path.join(root, id), { mode: 0o700 });
      await persist(job);
    } catch (error) { active = null; pending.delete(startup); started(); throw error; }
    const task = (async () => {
      try {
        const outputDir = path.join(root, id, 'artifacts');
        if (remote) {
          let candidate;
          if (input.repairMode === 'nemotron') {
            candidate = await generateRepairCandidate(inferenceRuntime);
            job.inference = candidate.provenance;
            await persist(job);
          }
          await sandbox({ type: input.type, ...(input.type === 'verify' ? { app: input.app, scenario: input.scenario, ...(input.prompt ? { prompt: input.prompt } : {}) } : {}), outputDir, ...(candidate ? { candidateSource: candidate.source } : {}) });
          if (candidate) await writeFile(path.join(outputDir, 'inference.json'), JSON.stringify(candidate.provenance, null, 2), { flag: 'wx', mode: 0o600 });
        }
        else if (input.type === 'repair') await repair({ outputDir });
        else await verify({ app: input.app, scenario: input.scenario, ...(input.prompt ? { prompt: input.prompt } : {}), outputDir });
        const primaryBytes = await readSafe(root, `${id}/artifacts/${input.type === 'repair' ? 'summary.json' : 'evidence.json'}`);
        const result = JSON.parse(primaryBytes);
        if (!validResult(result, job)) throw new Error('Run evidence has an invalid structure or local-only scope.');
        const execution = await sandboxReceipt(job, result);
        await persist({ ...job, primaryArtifactSha256: sha256(primaryBytes), ...(execution ? { execution } : {}), status: 'finished', finishedAt: new Date().toISOString(), verdict: input.type === 'repair' ? result.status : result.verdict?.kind ?? 'unverified' });
      } catch (error) {
        await persist({ ...job, status: 'failed', error: error.message, finishedAt: new Date().toISOString(), verdict: 'unverified' });
      } finally { active = null; }
    })();
    pending.add(task);
    pending.delete(startup);
    started();
    task.then(() => pending.delete(task), () => pending.delete(task));
    return { job };
  }
  return {
    async handle(action, input) {
      if (action === 'run') return run(input);
      if (action === 'bundle') { fields(input, []); return { destination: 'https://api.tokenfactory.nebius.com/sandboxes', files: await sandboxBundleManifest(), candidate: 'Nemotron repair adds one generated candidate file; credentials stay outside the remote execution environment.' }; }
      if (action === 'list') { fields(input, []); return list(); }
      if (action === 'detail') { fields(input, ['id']); return detail(input.id); }
      throw new Error('Unknown verifier operation.');
    },
    async artifact(id, file) {
      if (!ID.test(id) || !artifacts.has(file)) throw new Error('Unknown run artifact.');
      await load(id);
      return readSafe(root, `${id}/artifacts/${file}`);
    },
    async close() { closing = true; while (pending.size) await Promise.allSettled([...pending]); },
  };
}
