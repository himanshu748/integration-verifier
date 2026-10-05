import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executeRegression } from "../src/verifier/regressionProcess.js";

const posixOnly = { skip: process.platform === "win32" };
// Match the replay's explicit environment and avoid inheriting NODE_TEST_CONTEXT
// from this test worker into the independent regression test runner.
const regressionEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR
};

async function fixture(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), "regression-process-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const testPath = path.join(root, "fixture.test.mjs");
  await writeFile(testPath, source);
  return { testPath, root };
}

test("passing regression returns captured stdout and stderr with exit zero", posixOnly, async (t) => {
  const { testPath } = await fixture(t, `
    import test from "node:test";
    import assert from "node:assert/strict";
    test("receipt-pass", () => {
      console.log("captured stdout");
      console.error("captured stderr");
      assert.equal(2 + 2, 4);
    });
  `);
  const result = await executeRegression({ testPath, env: regressionEnv, timeoutMs: 30000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /receipt-pass/);
  assert.match(result.stdout + result.stderr, /captured stdout/);
  assert.match(result.stdout + result.stderr, /captured stderr/);
});

test("assertion failures return a real exit-one receipt", posixOnly, async (t) => {
  const { testPath } = await fixture(t, `
    import test from "node:test";
    import assert from "node:assert/strict";
    test("receipt-fail", () => assert.equal("actual", "expected"));
  `);
  const result = await executeRegression({ testPath, env: regressionEnv, timeoutMs: 30000 });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /not ok.*receipt-fail/);
  assert.match(result.stdout, /ERR_ASSERTION/);
});

for (const stubborn of [false, true]) {
  test(`timeout removes ${stubborn ? "SIGTERM-ignoring" : "ordinary"} descendants after the runner exits`, posixOnly, async (t) => {
    const { testPath, root } = await fixture(t, `
      import test from "node:test";
      import { spawn } from "node:child_process";
      test("stalled regression", async () => {
        spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(`
          import { writeFileSync } from "node:fs";
          ${stubborn ? 'process.on("SIGTERM", () => {});' : ""}
          writeFileSync(process.env.REGRESSION_CHILD_PID, String(process.pid));
          setInterval(() => {}, 1000);
        `)}], { stdio: "ignore" });
        await new Promise(() => {});
      });
    `);
    const pidPath = path.join(root, "child.pid");
    let descendantPid;
    t.after(() => {
      if (descendantPid) killIfPresent(descendantPid);
    });
    const outcome = executeRegression({
      testPath,
      env: { ...regressionEnv, REGRESSION_CHILD_PID: pidPath },
      timeoutMs: 15000
    }).then((value) => ({ value }), (error) => ({ error }));
    descendantPid = await readPid(pidPath);
    const { error, value } = await outcome;
    assert.equal(value, undefined);
    assert.equal(error?.code, "REGRESSION_TIMEOUT");
    assert.match(error.message, /timed out after 15000 ms/);
    await assertProcessGone(descendantPid);
  });
}

test("combined output overflow is bounded and rejects the regression", posixOnly, async (t) => {
  const { testPath } = await fixture(t, `
    import test from "node:test";
    test("overflow", async () => {
      const chunk = "x".repeat(32 * 1024);
      for (let index = 0; index < 40; index++) {
        console.log(chunk);
        console.error(chunk);
      }
      await new Promise(() => {});
    });
  `);
  await assert.rejects(executeRegression({ testPath, env: regressionEnv, timeoutMs: 30000 }), (error) => {
    assert.equal(error.code, "REGRESSION_OUTPUT_LIMIT");
    assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 1024 * 1024);
    return true;
  });
});

async function readPid(pidPath) {
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  assert.fail("Regression fixture never recorded its descendant PID");
}

async function assertProcessGone(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  }
  assert.fail(`Regression descendant ${pid} remained alive after process cleanup`);
}

function killIfPresent(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
