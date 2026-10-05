import { spawn } from "node:child_process";
import path from "node:path";

const maxOutputBytes = 1024 * 1024;
const terminationGraceMs = 2000;

// Trusted regression subprocesses share a POSIX process group. Playwright starts
// a separate browser group and cooperatively closes it on SIGTERM. This is not
// containment for arbitrary programs that detach and ignore shutdown signals.
export async function executeRegression({ testPath, env, timeoutMs = 90_000 } = {}) {
  if (process.platform === "win32") {
    throw new Error("Regression process cleanup requires POSIX process groups; Windows is unsupported");
  }
  if (typeof testPath !== "string" || testPath.trim().length === 0) {
    throw new TypeError("A regression test path is required");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Regression timeoutMs must be a positive timer-safe integer");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", path.resolve(testPath)], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let failure;
    let closed = false;
    let exitCode = null;
    let waitingForGrace = false;
    const deadline = setTimeout(() => stop(fault(
      `Regression process timed out after ${timeoutMs} ms; terminated its process group`,
      "REGRESSION_TIMEOUT"
    )), timeoutMs);

    function signalGroup(signal) {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          failure = fault(`Could not ${signal} regression process group: ${error.message}`, "REGRESSION_CLEANUP", error);
          child.kill("SIGKILL");
        }
      }
    }

    function stop(error) {
      if (failure) return;
      failure = error;
      clearTimeout(deadline);
      if (child.pid) {
        waitingForGrace = true;
        signalGroup("SIGTERM");
        // Keep this timer even if the test runner closes first: a child may
        // ignore SIGTERM and still belong to the original process group.
        setTimeout(() => {
          signalGroup("SIGKILL");
          waitingForGrace = false;
          finish();
        }, terminationGraceMs);
      }
      finish();
    }

    function finish() {
      if (!closed || waitingForGrace) return;
      clearTimeout(deadline);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode
      };
      if (failure) {
        Object.assign(failure, output);
        reject(failure);
      } else {
        resolve(output);
      }
    }

    function collect(destination, chunk) {
      if (failure) return;
      const remaining = maxOutputBytes - outputBytes;
      const retained = chunk.subarray(0, remaining);
      destination.push(retained);
      outputBytes += retained.length;
      if (chunk.length > remaining) {
        stop(fault(`Regression output exceeded ${maxOutputBytes} bytes`, "REGRESSION_OUTPUT_LIMIT"));
      }
    }

    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdout.on("error", (error) => stop(fault(`Regression stdout failed: ${error.message}`, "REGRESSION_OUTPUT", error)));
    child.stderr.on("error", (error) => stop(fault(`Regression stderr failed: ${error.message}`, "REGRESSION_OUTPUT", error)));
    child.on("error", (error) => stop(fault(`Regression process could not start: ${error.message}`, "REGRESSION_START", error)));
    child.once("close", (code, signal) => {
      closed = true;
      exitCode = code;
      clearTimeout(deadline);
      if (!failure && signal) {
        stop(fault(`Regression process exited unexpectedly from ${signal}`, "REGRESSION_SIGNAL"));
      } else if (!failure && code !== 0 && code !== 1) {
        stop(fault(`Regression process exited unexpectedly with code ${code}`, "REGRESSION_EXIT"));
      } else if (!failure) {
        // A completed runner must not leave same-group background work alive.
        signalGroup("SIGKILL");
      }
      finish();
    });
  });
}

function fault(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
