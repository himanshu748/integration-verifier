import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerification } from "./run.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const cases = [
  {
    name: "fake fallback hides provider failure",
    app: "fake-fallback",
    scenario: "provider-fail",
    expectedVerdict: "contract_violation"
  },
  {
    name: "honest app propagates controlled provider response",
    app: "honest-live",
    scenario: "marker",
    expectedVerdict: "observed_controlled_path"
  },
  {
    name: "declared fallback reports provider failure honestly",
    app: "declared-fallback",
    scenario: "provider-fail",
    expectedVerdict: "observed_honest_failure"
  },
  {
    name: "fake fallback hides malformed provider response",
    app: "fake-fallback",
    scenario: "malformed",
    expectedVerdict: "contract_violation"
  },
  {
    name: "declared fallback reports malformed provider response honestly",
    app: "declared-fallback",
    scenario: "malformed",
    expectedVerdict: "observed_honest_failure"
  }
];

export async function runLocalSuite({
  outputDir = path.join(repoRoot, "work", "evidence", `local-suite-${Date.now()}`)
} = {}) {
  await mkdir(outputDir, { recursive: true });
  const results = [];

  for (const suiteCase of cases) {
    const caseDir = path.join(outputDir, `${suiteCase.app}-${suiteCase.scenario}`);
    const { evidence } = await runVerification({
      app: suiteCase.app,
      scenario: suiteCase.scenario,
      outputDir: caseDir
    });
    const matched = evidence.verdict.kind === suiteCase.expectedVerdict;
    results.push({
      ...suiteCase,
      actualVerdict: evidence.verdict.kind,
      matched,
      evidencePath: path.join(caseDir, "evidence.json")
    });
  }

  const summary = {
    status: results.every((result) => result.matched) ? "ok" : "failed",
    generatedAt: new Date().toISOString(),
    cases: results
  };

  await writeFile(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  return { outputDir, summary };
}
