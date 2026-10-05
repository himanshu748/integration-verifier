export function createDefaultContract() {
  return {
    providerPath: "/v1/chat/completions",
    expectedModel: "nvidia/test-nemotron",
    fallbackDisclosureRequired: true,
    unavailableStatusMinimum: 500,
    acceptedFallbackStatuses: ["fallback", "unavailable"]
  };
}

export function isValidContract(contract) {
  return isRecord(contract) &&
    typeof contract.providerPath === "string" && contract.providerPath.startsWith("/") &&
    !/\s/.test(contract.providerPath) &&
    isNonemptyString(contract.expectedModel) &&
    typeof contract.fallbackDisclosureRequired === "boolean" &&
    Number.isInteger(contract.unavailableStatusMinimum) &&
    contract.unavailableStatusMinimum >= 400 && contract.unavailableStatusMinimum <= 599 &&
    Array.isArray(contract.acceptedFallbackStatuses) && contract.acceptedFallbackStatuses.length > 0 &&
    contract.acceptedFallbackStatuses.every(isNonemptyString);
}

export function isHonestUnavailableResponse(evidence) {
  if (!isRecord(evidence)) return false;
  const { contract, workflowStatus, workflowBody } = evidence;
  if (!isValidContract(contract) || !isRecord(workflowBody) ||
      !Number.isInteger(workflowStatus) || workflowStatus > 599 ||
      workflowStatus < contract.unavailableStatusMinimum ||
      !isNonemptyString(workflowBody.answer) || !isNonemptyString(workflowBody.status)) {
    return false;
  }

  const statusLabel = workflowBody.status.trim().toLowerCase();
  const acceptedStatus = contract.acceptedFallbackStatuses.some((status) => status.trim().toLowerCase() === statusLabel);
  if (!acceptedStatus || containsLiveClaim(workflowBody.answer) || containsLiveClaim(workflowBody.disclosure)) {
    return false;
  }

  // A status label or debug metadata is not a separate disclosure to the user.
  return !contract.fallbackDisclosureRequired ||
    (isNonemptyString(workflowBody.disclosure) &&
      /\b(?:fallback|unavailable)\b|\b(?:not|no)\s+(?:a\s+)?live\b/i.test(workflowBody.disclosure));
}

function containsLiveClaim(value) {
  if (typeof value !== "string") return false;
  const text = value.replace(/\b(?:not|no|never)\s+(?:a\s+)?live\b/gi, "unavailable");
  return /\blive\s+(?:ai\s+)?(?:answer|response|output|result)\b|\b(?:answer|response|output|result)\s+(?:(?:is|was)\s+)?live\b|\bprovider response displayed\b/i.test(text);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
