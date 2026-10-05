const brokenResponse = `      return sendJson(response, 200, {
        answer: "Live AI answer: your plan is ready. MOCK_DATA_FALLBACK",
        status: "live",
        disclosure: "provider response displayed"
      });`;
const honestResponse = `      return sendJson(response, 503, {
        answer: "Provider unavailable. This response is not live AI.",
        status: "unavailable",
        disclosure: "provider unavailable; no live answer displayed"
      });`;

export function createLocalRepair(source) {
  if (typeof source !== "string" || !source.endsWith("\n")) {
    throw new Error("Repair requires a complete source file ending with a newline");
  }
  const index = source.indexOf(brokenResponse);
  if (index < 0 || source.indexOf(brokenResponse, index + 1) !== -1) {
    throw new Error("Local repair requires exactly one matching sample fallback");
  }
  const repairedSource = source.replace(brokenResponse, honestResponse);
  const line = source.slice(0, index).split("\n").length;
  const oldLines = brokenResponse.split("\n");
  const newLines = honestResponse.split("\n");
  // Include the surrounding catch and closing brace so git can validate context.
  const lines = source.split("\n");
  const hunk = [
    ` ${lines[line - 2]}`,
    ...oldLines.map((value) => `-${value}`),
    ...newLines.map((value) => `+${value}`),
    ` ${lines[line - 1 + oldLines.length]}`
  ].join("\n");
  const patch = `diff --git a/src/sample-apps/server.js b/src/sample-apps/server.js
--- a/src/sample-apps/server.js
+++ b/src/sample-apps/server.js
@@ -${line - 1},${oldLines.length + 2} +${line - 1},${newLines.length + 2} @@
${hunk}
`;
  return { repairedSource, patch };
}

export function repairSuggestion({ app, source }) {
  if (app !== "fake-fallback") {
    return {
      summary: "No deterministic local repair template is available for this sample app."
    };
  }

  let patch;
  try { patch = createLocalRepair(source).patch; }
  catch { return { source: "deterministic-local-template", summary: "Source does not match the local repair template.", patch: null }; }
  return {
    source: "deterministic-local-template",
    summary: "Return an honest unavailable response when the provider call fails.",
    regressionTest: "Provider failure must produce the required error status AND disclose unavailability; available responses must still reach the answer.",
    patch
  };
}
