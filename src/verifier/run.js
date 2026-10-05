import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoundary } from "./boundary.js";
import { startSampleProcess, validateExecutionUser } from "./sampleProcess.js";
import { runBrowserWorkflow } from "./browserWorkflow.js";
import { createDefaultContract } from "./contract.js";
import { judgeEvidence } from "./judge.js";
import { repairSuggestion } from "./repair.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const sampleAppEntry = path.join(repoRoot, "src/sample-apps/server.js");
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function runVerification({
  app = "fake-fallback",
  scenario = "provider-fail",
  prompt = "write a launch checklist",
  appEntry = sampleAppEntry,
  executionUser,
  outputDir = path.join(repoRoot, "work", "evidence", `${app}-${scenario}-${randomUUID()}`)
} = {}) {
  validateExecutionUser(executionUser);
  if (!["honest-live", "fake-fallback", "declared-fallback"].includes(app)) {
    throw new Error(`Unsupported sample app: ${app}`);
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A nonempty prompt is required");
  // Trusted local fixtures only: a separate process is not an untrusted-code sandbox.
  const source = await readFile(appEntry, "utf8");
  await mkdir(outputDir, { recursive: true });
  const contract = createDefaultContract();
  let boundary;
  let application;
  const appLogs = [];
  const startedAt = new Date().toISOString();
  try {
    boundary = await startBoundary({ scenario });
    application = await startSampleProcess({
      appEntry, app, baseUrl: boundary.baseUrl, model: contract.expectedModel, logs: appLogs, executionUser
    });
    const workflow = await runBrowserWorkflow({
      baseUrl: application.baseUrl,
      prompt,
      outputDir
    });
    const verdict = judgeEvidence({
      scenario,
      contract,
      providerRequests: boundary.requests,
      workflowStatus: workflow.workflowStatus,
      workflowBody: workflow.workflowBody,
      marker: boundary.marker,
      expectedPrompt: prompt
    });
    const evidence = {
      verifierVersion: "0.2.0",
      startedAt,
      completedAt: new Date().toISOString(),
      evidenceScope: "local-controlled-provider",
      liveInferenceVerified: false,
      sourceSha256: sha256(source),
      contractSha256: sha256(JSON.stringify(contract)),
      app,
      scenario,
      verdict,
      contract,
      observations: {
        pageLoaded: workflow.pageTitle === app,
        workflowStatus: workflow.workflowStatus,
        workflowBody: workflow.workflowBody,
        browserRequests: workflow.browserRequests,
        browserResponses: workflow.browserResponses,
        providerRequests: boundary.requests,
        syntheticMarker: boundary.marker,
        screenshotPath: workflow.screenshotPath,
        tracePath: workflow.tracePath
      },
      repair: verdict.kind === "contract_violation" ? repairSuggestion({ app, source }) : null
    };

    await writeFile(path.join(outputDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    if (evidence.repair?.patch) {
      await writeFile(path.join(outputDir, "repair.patch"), evidence.repair.patch);
    }
    return { evidence, outputDir };
  } catch (error) {
    await writeFile(path.join(outputDir, "failure.json"), JSON.stringify({
      evidenceScope: "local-controlled-provider", liveInferenceVerified: false,
      verdict: { kind: "unverified", reason: error.message }, app, scenario, startedAt
    }, null, 2));
    throw error;
  } finally {
    try { await application?.close(); }
    finally {
      try { await boundary?.close(); }
      finally { await writeFile(path.join(outputDir, "app.log"), appLogs.join("")); }
    }
  }
}
