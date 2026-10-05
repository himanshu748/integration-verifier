import { isHonestUnavailableResponse, isValidContract } from "./contract.js";

export function judgeEvidence(evidence) {
  if (!isRecord(evidence)) {
    return { kind: "unverified", reason: "workflow evidence is missing or invalid" };
  }
  const { scenario, contract, providerRequests, workflowStatus, workflowBody, marker, expectedPrompt } = evidence;
  if (!["marker", "provider-fail", "malformed"].includes(scenario)) {
    return { kind: "unverified", reason: `no judge implemented for scenario ${scenario}` };
  }
  if (!isValidContract(contract)) {
    return { kind: "unverified", reason: "integration contract is missing or invalid" };
  }
  if (!Number.isInteger(workflowStatus) || workflowStatus < 100 || workflowStatus > 599 ||
      !isRecord(workflowBody) || workflowBody.parseError) {
    return { kind: "unverified", reason: "workflow response evidence is missing or invalid" };
  }
  if (!Array.isArray(providerRequests) || providerRequests.some((request) =>
    !isRecord(request) || typeof request.method !== "string" || typeof request.url !== "string" ||
    (request.method === "POST" && (!isRecord(request.body) || request.body.parseError))
  )) {
    return { kind: "unverified", reason: "provider request evidence is missing or invalid" };
  }
  if (expectedPrompt !== undefined && !isNonemptyString(expectedPrompt)) {
    return { kind: "unverified", reason: "expected workflow prompt is invalid" };
  }
  if (scenario === "marker" && !isNonemptyString(marker)) {
    return { kind: "unverified", reason: "provider marker evidence is missing or invalid" };
  }
  const providerWasCalled = providerRequests.some((request) =>
    request.method === "POST" && request.url === contract.providerPath &&
    request.body.model === contract.expectedModel && request.authorizationPresent === true &&
    Array.isArray(request.body.messages) && request.body.messages.some((message) =>
      isRecord(message) && message.role === "user" && isNonemptyString(message.content) &&
      (expectedPrompt === undefined || message.content === expectedPrompt)
    )
  );
  const markerPropagated = typeof marker === "string" && marker.length > 0 &&
    typeof workflowBody.answer === "string" && workflowBody.answer.includes(marker);

  if (!providerWasCalled) {
    return {
      kind: "contract_violation",
      reason: "workflow did not call the expected provider with the required model, authorization, and user prompt"
    };
  }

  if (scenario === "marker") {
    return markerPropagated && workflowStatus >= 200 && workflowStatus < 300
      ? { kind: "observed_controlled_path", reason: "synthetic provider marker reached the user-visible answer; live inference remains unverified" }
      : { kind: "contract_violation", reason: "provider was called, but its response did not reach the workflow output" };
  }

  if (scenario === "provider-fail") {
    if (isHonestUnavailableResponse({ contract, workflowStatus, workflowBody })) {
      return { kind: "observed_honest_failure", reason: "provider failure was represented honestly to the user" };
    }

    return {
      kind: "contract_violation",
      reason: "provider failure did not satisfy the unavailable-response contract"
    };
  }

  if (scenario === "malformed") {
    if (isHonestUnavailableResponse({ contract, workflowStatus, workflowBody })) {
      return { kind: "observed_honest_failure", reason: "malformed provider response was represented honestly to the user" };
    }

    return {
      kind: "contract_violation",
      reason: "malformed provider response did not satisfy the unavailable-response contract"
    };
  }

  return { kind: "unverified", reason: `no judge implemented for scenario ${scenario}` };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
