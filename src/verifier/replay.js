import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalRepair } from "./repair.js";
import { sampleAppEntry, sha256 } from "./run.js";
import { executeRegression } from "./regressionProcess.js";

const execute = promisify(execFile);
const scenarios = ["provider-fail", "malformed", "marker"];

// This file remains outside the patchable application copy during both executions.
const regressionSource = `import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
const { runVerification } = await import(process.env.VERIFIER_MODULE_URL);
for (const scenario of ["provider-fail", "malformed", "marker"]) {
  test(scenario + " preserves the integration contract", async () => {
    const { evidence } = await runVerification({
      app: "fake-fallback", scenario,
      appEntry: process.env.VERIFIER_APP_ENTRY,
      outputDir: path.join(process.env.VERIFIER_EVIDENCE_DIR, scenario)
    });
    assert.equal(evidence.verdict.kind,
      scenario === "marker" ? "observed_controlled_path" : "observed_honest_failure");
    assert.equal(evidence.liveInferenceVerified, false);
  });
}
`;

export async function runRepairReplay({ outputDir = path.resolve("work/evidence", `repair-replay-${randomUUID()}`) } = {}) {
  outputDir = path.resolve(outputDir);
  // A fresh directory prevents old receipts from being mistaken for a new run.
  await mkdir(path.dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "integration-repair-"));
  try {
    const source = await readFile(sampleAppEntry, "utf8");
    const { repairedSource, patch } = createLocalRepair(source);
    const appEntry = path.join(temporaryRoot, "src/sample-apps/server.js");
    await mkdir(path.dirname(appEntry), { recursive: true });
    await writeFile(path.join(temporaryRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(appEntry, source);
    await writeFile(path.join(outputDir, "app.before.js"), source);
    const patchPath = path.join(outputDir, "repair.patch");
    const testPath = path.join(outputDir, "regression.test.mjs");
    await writeFile(patchPath, patch);
    await writeFile(testPath, regressionSource);

    const before = await runRegression({ testPath, appEntry, evidenceDir: path.join(outputDir, "before") });
    const beforeEvidence = await readScenarios(path.join(outputDir, "before"));
    if (before.exitCode !== 1 ||
        !beforeEvidence.slice(0, 2).every((e) => e.verdict.kind === "contract_violation") ||
        beforeEvidence[2].verdict.kind !== "observed_controlled_path") {
      throw new Error("Expected baseline behavior was not observed; repair was not applied");
    }
    await execute("git", ["apply", "--check", patchPath], { cwd: temporaryRoot, timeout: 5000 });
    await execute("git", ["apply", patchPath], { cwd: temporaryRoot, timeout: 5000 });
    const appliedSource = await readFile(appEntry, "utf8");
    if (appliedSource !== repairedSource) throw new Error("Applied patch differs from the intended local repair");
    await writeFile(path.join(outputDir, "app.after.js"), appliedSource);
    const after = await runRegression({ testPath, appEntry, evidenceDir: path.join(outputDir, "after") });

    const afterEvidence = await readScenarios(path.join(outputDir, "after"));
    const contractHashes = new Set([...beforeEvidence, ...afterEvidence].map((entry) => entry.contractSha256));
    const unchangedRegression = (await readFile(testPath, "utf8")) === regressionSource;
    const sourceUnchanged = (await readFile(sampleAppEntry, "utf8")) === source;
    const checks = {
      regressionFailedBefore: before.exitCode === 1,
      regressionPassedAfter: after.exitCode === 0,
      failuresExposedBefore: beforeEvidence.slice(0, 2).every((e) => e.verdict.kind === "contract_violation"),
      failuresDisclosedAfter: afterEvidence.slice(0, 2).every((e) => e.verdict.kind === "observed_honest_failure"),
      successfulPathPreserved: [beforeEvidence[2], afterEvidence[2]].every((e) => e.verdict.kind === "observed_controlled_path"),
      sourceEvidenceMatches: beforeEvidence.every((e) => e.sourceSha256 === sha256(source)) &&
        afterEvidence.every((e) => e.sourceSha256 === sha256(appliedSource)),
      unchangedContract: contractHashes.size === 1,
      unchangedRegression,
      originalSourceUnchanged: sourceUnchanged
    };
    const summary = {
      status: Object.values(checks).every(Boolean) ? "verified_local_repair" : "not_verified",
      generatedAt: new Date().toISOString(),
      repairSource: "deterministic-local-template",
      evidenceScope: "local-controlled-provider",
      liveInferenceVerified: false,
      regressionSha256: sha256(regressionSource),
      contractSha256: beforeEvidence[0].contractSha256,
      originalSourceSha256: sha256(source),
      repairedSourceSha256: sha256(appliedSource),
      checks, before, after,
      scenarios: scenarios.map((scenario, index) => ({
        scenario, before: beforeEvidence[index].verdict, after: afterEvidence[index].verdict,
        beforeEvidence: `before/${scenario}/evidence.json`,
        afterEvidence: `after/${scenario}/evidence.json`
      }))
    };
    await writeFile(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    return { outputDir, summary };
  } catch (error) {
    await writeFile(path.join(outputDir, "failure.json"), JSON.stringify({
      status: "not_verified", reason: error.message, liveInferenceVerified: false
    }, null, 2));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runRegression({ testPath, appEntry, evidenceDir }) {
  await mkdir(evidenceDir, { recursive: true });
  const output = await executeRegression({
      testPath,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        VERIFIER_MODULE_URL: new URL("./run.js", import.meta.url).href,
        VERIFIER_APP_ENTRY: appEntry, VERIFIER_EVIDENCE_DIR: evidenceDir
      }
  }).catch(async (error) => {
    await writeFile(path.join(evidenceDir, "regression.log"), (error.stdout ?? "") + (error.stderr ?? "") + "\n" + error.message);
    throw error;
  });
  await writeFile(path.join(evidenceDir, "regression.log"), output.stdout + output.stderr);
  return { exitCode: output.exitCode, logPath: path.join(evidenceDir, "regression.log") };
}

async function readScenarios(directory) {
  return Promise.all(scenarios.map(async (scenario) =>
    JSON.parse(await readFile(path.join(directory, scenario, "evidence.json"), "utf8").catch(() => {
      throw new Error(`Missing ${scenario} workflow evidence; inspect ${path.join(directory, "regression.log")}`);
    }))
  ));
}
