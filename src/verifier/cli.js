import { parseArgs } from "node:util";
import { runVerification } from "./run.js";

const { values } = parseArgs({
  options: {
    app: { type: "string", default: "fake-fallback" },
    scenario: { type: "string", default: "provider-fail" }
  }
});

const result = await runVerification({
  app: values.app,
  scenario: values.scenario
});

console.log(JSON.stringify({
  verdict: result.evidence.verdict,
  evidence: result.outputDir
}, null, 2));

if (result.evidence.verdict.kind === "contract_violation") {
  process.exitCode = 2;
}
if (result.evidence.verdict.kind === "unverified") {
  process.exitCode = 3;
}
