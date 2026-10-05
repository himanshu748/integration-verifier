import { spawn } from "node:child_process";

// The OS selects the port; the child reports it over IPC after listen succeeds.
export function validateExecutionUser(value) {
  if (value !== undefined && (!value || Object.keys(value).some((key) => !['uid', 'gid'].includes(key)) ||
      !['uid', 'gid'].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 2147483647))) {
    throw new Error('Execution user must contain positive uid and gid values.');
  }
}

export async function startSampleProcess({ appEntry, app, baseUrl, model, logs, timeoutMs = 15000, executionUser }) {
  validateExecutionUser(executionUser);
  const child = spawn(process.execPath, [appEntry], {
    ...(executionUser ? { uid: executionUser.uid, gid: executionUser.gid } : {}),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      PORT: "0",
      SAMPLE_APP: app,
      PROVIDER_BASE_URL: baseUrl,
      APP_MODEL: model,
      APP_AI_KEY: "verifier-test-key"
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let logBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      if (logBytes < 64 * 1024) {
        const text = chunk.toString("utf8").slice(0, 64 * 1024 - logBytes);
        logs.push(text);
        logBytes += text.length;
      }
    });
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("sample app startup timed out")), timeoutMs);
      const onError = (error) => finish(error);
      const onExit = (code, signal) => finish(new Error(`sample app exited before readiness (${code ?? signal})`));
      const onMessage = (message) => {
        if (message?.event === "sample_app_ready" && Number.isInteger(message.port) &&
            message.port > 0 && message.port <= 65535) finish(null, message.port);
      };
      function finish(error, value) {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        error ? reject(error) : resolve(value);
      }
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    return { baseUrl: `http://127.0.0.1:${port}`, close: () => stopChild(child) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
