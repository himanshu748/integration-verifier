import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runVerification } from "../src/verifier/run.js";
import { runLocalSuite } from "../src/verifier/suite.js";
import { chooseCandidateModel, getTokenFactoryConfig } from "../src/integrations/tokenFactory.js";

test("fake fallback is rejected when provider fails", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "verifier-fake-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { evidence } = await runVerification({
    app: "fake-fallback",
    scenario: "provider-fail",
    outputDir
  });

  assert.equal(evidence.verdict.kind, "contract_violation");
  assert.match(evidence.verdict.reason, /unavailable-response contract/);
  assert.equal(evidence.observations.providerRequests.length, 1);
  assert.equal(evidence.repair.regressionTest.includes("Provider failure"), true);
});

test("honest app proves controlled response propagation", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "verifier-honest-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { evidence } = await runVerification({
    app: "honest-live",
    scenario: "marker",
    outputDir
  });

  assert.equal(evidence.verdict.kind, "observed_controlled_path");
  assert.equal(
    JSON.stringify(evidence.observations.workflowBody).includes(evidence.observations.syntheticMarker),
    true
  );
});

test("declared fallback is accepted when provider fails honestly", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "verifier-declared-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { evidence } = await runVerification({
    app: "declared-fallback",
    scenario: "provider-fail",
    outputDir
  });

  assert.equal(evidence.verdict.kind, "observed_honest_failure");
  assert.equal(evidence.observations.workflowStatus, 503);
  assert.match(JSON.stringify(evidence.observations.workflowBody), /Fallback mode/);
});

test("token factory config does not invent credentials", () => {
  const config = getTokenFactoryConfig({});

  assert.equal(config.baseUrl, "https://api.tokenfactory.nebius.com/v1");
  assert.equal(config.apiKey, "");
  assert.equal(config.model, "");
});

test("candidate model selection prefers configured model", () => {
  const models = [
    { id: "meta/example" },
    { id: "nvidia/example-nemotron" }
  ];

  assert.deepEqual(chooseCandidateModel(models, "meta/example"), { id: "meta/example" });
  assert.deepEqual(chooseCandidateModel(models), { id: "nvidia/example-nemotron" });
  assert.equal(chooseCandidateModel([{ id: "meta/example" }]), null);
});

test("local suite treats expected contract violations as successful coverage", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "verifier-suite-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { summary } = await runLocalSuite({ outputDir });

  assert.equal(summary.status, "ok");
  assert.equal(summary.cases.length, 5);
  assert.equal(summary.cases.every((suiteCase) => suiteCase.matched), true);
  assert.equal(
    summary.cases.some((suiteCase) => suiteCase.actualVerdict === "contract_violation"),
    true
  );
});
