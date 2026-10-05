import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSampleProcess } from "../src/verifier/sampleProcess.js";
import { sampleAppEntry } from "../src/verifier/run.js";

test("startup failure and stalled readiness terminate with a useful error", { timeout: 25000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sample-process-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = { app: "honest-live", baseUrl: "http://127.0.0.1:1", model: "test", logs: [] };
  await assert.rejects(startSampleProcess({ ...defaults, appEntry: path.join(root, "missing.mjs") }), /before readiness/);
  const stalled = path.join(root, "stalled.mjs");
  await writeFile(stalled, 'console.log(process.pid); setInterval(() => {}, 1000);\n');
  const logs = [];
  await assert.rejects(startSampleProcess({ ...defaults, appEntry: stalled, logs, timeoutMs: 5000 }), /startup timed out/);
  const pid = Number(logs.join("").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("reported app port serves the app and is released after close", async () => {
  const application = await startSampleProcess({
    appEntry: sampleAppEntry, app: "honest-live", baseUrl: "http://127.0.0.1:1", model: "test", logs: []
  });
  try {
    const response = await fetch(application.baseUrl, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /honest-live/);
  } finally { await application.close(); }
  await assert.rejects(fetch(application.baseUrl, { signal: AbortSignal.timeout(1000) }));
});
