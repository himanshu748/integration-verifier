import test from "node:test";
import assert from "node:assert/strict";
import { judgeEvidence } from "../src/verifier/judge.js";
import { createDefaultContract, isHonestUnavailableResponse } from "../src/verifier/contract.js";

const prompt = "write a launch checklist";

function providerRequest(overrides = {}) {
  return {
    method: "POST",
    url: "/v1/chat/completions",
    authorizationPresent: true,
    body: { model: "nvidia/test-nemotron", messages: [{ role: "user", content: prompt }] },
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    scenario: "marker",
    contract: createDefaultContract(),
    providerRequests: [providerRequest()],
    workflowStatus: 200,
    workflowBody: { answer: "unique-marker", status: "live" },
    marker: "unique-marker",
    expectedPrompt: prompt,
    ...overrides
  };
}

for (const request of [
  { method: "GET", url: "/health" },
  providerRequest({ body: { model: "wrong-model", messages: [{ role: "user", content: prompt }] } }),
  providerRequest({ authorizationPresent: false })
]) {
  test(`rejects unrelated or invalid provider request ${JSON.stringify(request)}`, () => {
    assert.equal(judgeEvidence(evidence({ providerRequests: [request] })).kind, "contract_violation");
  });
}

test("marker in metadata does not prove answer propagation", () => {
  assert.equal(judgeEvidence(evidence({ workflowBody: { answer: "fake", debug: "unique-marker" } })).kind, "contract_violation");
});

test("missing workflow response remains unverified", () => {
  assert.equal(judgeEvidence(evidence({ workflowStatus: 0 })).kind, "unverified");
});

test("unknown scenarios remain unverified even with no requests", () => {
  assert.equal(judgeEvidence(evidence({ scenario: "typo", providerRequests: [] })).kind, "unverified");
});

test("failed HTTP response cannot prove successful propagation", () => {
  assert.equal(judgeEvidence(evidence({ workflowStatus: 500 })).kind, "contract_violation");
});

test("complete request and marker evidence proves only the controlled path", () => {
  assert.equal(judgeEvidence(evidence()).kind, "observed_controlled_path");
});

test("absent or malformed evidence remains unverified without crashing", () => {
  for (const input of [undefined, null, [], "invalid"]) {
    assert.equal(judgeEvidence(input).kind, "unverified");
    assert.equal(isHonestUnavailableResponse(input), false);
  }
  for (const overrides of [
    { contract: undefined }, { contract: [] }, { contract: {} },
    { contract: { ...createDefaultContract(), acceptedFallbackStatuses: null } },
    { contract: { ...createDefaultContract(), unavailableStatusMinimum: 200 } },
    { contract: { ...createDefaultContract(), fallbackDisclosureRequired: "false" } },
    { providerRequests: undefined }, { providerRequests: {} }, { providerRequests: [null] },
    { providerRequests: [providerRequest({ body: undefined })] },
    { providerRequests: [providerRequest({ body: [] })] },
    { providerRequests: [providerRequest({ body: { parseError: true } })] },
    { workflowBody: undefined }, { workflowBody: [] }, { workflowBody: { parseError: true } },
    { marker: undefined }, { marker: "  " }, { expectedPrompt: "" }, { expectedPrompt: null }
  ]) {
    assert.equal(judgeEvidence(evidence(overrides)).kind, "unverified", JSON.stringify(overrides));
  }
});

test("an empty request log proves the expected provider was not called", () => {
  assert.equal(judgeEvidence(evidence({ providerRequests: [] })).kind, "contract_violation");
});

test("a provider call must include the current user prompt", () => {
  for (const messages of [undefined, [], [null], [{ role: "system", content: prompt }],
    [{ role: "user", content: "   " }], [{ role: "user", content: "an unrelated warmup request" }]]) {
    const request = providerRequest({ body: { model: "nvidia/test-nemotron", messages } });
    assert.equal(judgeEvidence(evidence({ providerRequests: [request] })).kind, "contract_violation");
  }
});

test("callers may omit expectedPrompt but still need meaningful user text", () => {
  assert.equal(judgeEvidence(evidence({ expectedPrompt: undefined })).kind, "observed_controlled_path");
  const request = providerRequest({ body: { model: "nvidia/test-nemotron", messages: [{ role: "user", content: "" }] } });
  assert.equal(judgeEvidence(evidence({ expectedPrompt: undefined, providerRequests: [request] })).kind, "contract_violation");
});

function failureEvidence(overrides = {}) {
  return evidence({
    scenario: "provider-fail",
    workflowStatus: 503,
    workflowBody: {
      answer: "Provider unavailable. This response is not live AI.",
      status: "unavailable",
      disclosure: "Provider unavailable; no live answer displayed."
    },
    ...overrides
  });
}

test("honest disclosures are recognized for both failure scenarios", () => {
  for (const scenario of ["provider-fail", "malformed"]) {
    assert.equal(judgeEvidence(failureEvidence({ scenario })).kind, "observed_honest_failure");
  }
});

test("a fallback status alone does not satisfy disclosure requirements", () => {
  for (const workflowBody of [
    { answer: "An answer", status: "fallback" },
    { answer: "An answer", status: "fallback", disclosure: " " },
    { answer: "Provider unavailable", status: "fallback", debug: "not live" },
    { status: "fallback", disclosure: "Provider unavailable" },
    { answer: " ", status: "fallback", disclosure: "Provider unavailable" }
  ]) {
    assert.equal(judgeEvidence(failureEvidence({ workflowBody })).kind, "contract_violation");
  }
});

test("contradictory live claims do not become honest through fallback metadata", () => {
  const base = failureEvidence().workflowBody;
  for (const workflowBody of [
    { ...base, answer: "Live AI answer: your plan is ready." },
    { ...base, answer: "This response is live." },
    { ...base, answer: "A live response generated your plan." },
    { ...base, disclosure: "Provider response displayed; fallback unavailable." }
  ]) {
    assert.equal(judgeEvidence(failureEvidence({ workflowBody })).kind, "contract_violation");
  }
});

test("failure verdicts respect HTTP threshold and accepted status labels", () => {
  assert.equal(judgeEvidence(failureEvidence({ workflowStatus: 200 })).kind, "contract_violation");
  assert.equal(judgeEvidence(failureEvidence({
    workflowStatus: 500,
    contract: { ...createDefaultContract(), unavailableStatusMinimum: 503 }
  })).kind, "contract_violation");
  assert.equal(judgeEvidence(failureEvidence({
    workflowBody: { ...failureEvidence().workflowBody, status: "live" }
  })).kind, "contract_violation");
});

test("contracts can waive separate disclosure without permitting empty or contradictory answers", () => {
  const contract = { ...createDefaultContract(), fallbackDisclosureRequired: false };
  assert.equal(judgeEvidence(failureEvidence({
    contract, workflowBody: { answer: "Service failed.", status: "unavailable" }
  })).kind, "observed_honest_failure");
  for (const answer of ["", "   ", "Live AI answer: ready."]) {
    assert.equal(judgeEvidence(failureEvidence({
      contract, workflowBody: { answer, status: "unavailable" }
    })).kind, "contract_violation");
  }
});
