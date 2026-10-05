import { parseArgs } from "node:util";
import { runRepairReplay } from "./replay.js";

try {
  const { values } = parseArgs({ options: { output: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: npm run verify:repair -- [--output NEW_DIRECTORY]\nApplies a deterministic sample repair in a temporary copy and runs unchanged browser regressions before and after. No cloud calls.");
  } else {
    const result = await runRepairReplay({ outputDir: values.output });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.summary.status === "verified_local_repair" ? 0 : 3;
  }
} catch (error) {
  console.error(JSON.stringify({ status: "not_verified", reason: error.message }));
  process.exitCode = 1;
}
