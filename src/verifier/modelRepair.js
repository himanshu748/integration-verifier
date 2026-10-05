import { readFile } from 'node:fs/promises';
import { sampleAppEntry, sha256 } from './run.js';
import { createDefaultContract } from './contract.js';

const repairSchema = {
  type: 'object', additionalProperties: false, required: ['source', 'explanation'],
  properties: {
    source: { type: 'string', minLength: 100, maxLength: 48 * 1024 },
    explanation: { type: 'string', minLength: 1, maxLength: 2000 },
  },
};

// The candidate is data on this machine. Only the remote sandbox may execute it.
export async function generateRepairCandidate(inferenceRuntime) {
  if (!inferenceRuntime?.generate) throw new Error('Nemotron inference is not configured.');
  const original = await readFile(sampleAppEntry, 'utf8');
  const { value, inference } = await inferenceRuntime.generate({
    purpose: 'verifier-repair', schemaName: 'isolated_repair_candidate', schema: repairSchema, maxTokens: 8192,
    system: 'Repair the supplied bundled Node.js sample application. Return the complete ES module source and a short explanation. The fake-fallback application silently returns a successful live answer after upstream failure or malformed output. Fix that branch to return HTTP 503 and disclose provider unavailability. Preserve the successful marker response, UI workflow, environment variable interface, and other sample modes. Keep the source self-contained using only Node built-ins. Do not edit tests, verifier, contract, or add dependencies. Your code will run unprivileged in an isolated remote sandbox; you cannot access credentials.',
    input: { filename: 'src/sample-apps/server.js', source: original, contract: createDefaultContract(), requiredScenarios: ['provider-fail', 'malformed', 'marker'] },
  });
  if (!value || typeof value.source !== 'string' || Buffer.byteLength(value.source) > 48 * 1024 || !value.source.trim()) throw new Error('Nemotron candidate exceeded the source limit or was empty.');
  return { source: value.source, provenance: {
    repairSource: 'nemotron-generated', originalSourceSha256: sha256(original), candidateSourceSha256: sha256(value.source),
    explanation: value.explanation, inference,
  } };
}
