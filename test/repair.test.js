import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalRepair } from "../src/verifier/repair.js";
import { sampleAppEntry } from "../src/verifier/run.js";

test("local repair produces an applicable diff even when source lines move", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repair-patch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = "// shifted source\n\n" + await readFile(sampleAppEntry, "utf8");
  const { patch, repairedSource } = createLocalRepair(source);
  const appPath = path.join(root, "src/sample-apps/server.js");
  await mkdir(path.dirname(appPath), { recursive: true });
  await writeFile(appPath, source);
  const patchPath = path.join(root, "repair.patch");
  await writeFile(patchPath, patch);
  await promisify(execFile)("git", ["apply", "--check", patchPath], { cwd: root });
  await promisify(execFile)("git", ["apply", patchPath], { cwd: root });
  assert.equal(await readFile(appPath, "utf8"), repairedSource);
  assert.ok(!repairedSource.includes("MOCK_DATA_FALLBACK"));
  assert.match(repairedSource, /const answer = await callProvider\(prompt\)/);
  assert.throws(() => createLocalRepair(repairedSource), /exactly one/);
  assert.throws(() => createLocalRepair(source + source), /exactly one/);
});
