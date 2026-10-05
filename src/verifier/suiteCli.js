import { runLocalSuite } from "./suite.js";

const { outputDir, summary } = await runLocalSuite();

console.log(JSON.stringify({
  status: summary.status,
  evidence: outputDir,
  cases: summary.cases.map((suiteCase) => ({
    name: suiteCase.name,
    expectedVerdict: suiteCase.expectedVerdict,
    actualVerdict: suiteCase.actualVerdict,
    matched: suiteCase.matched
  }))
}, null, 2));

if (summary.status !== "ok") {
  process.exitCode = 1;
}
