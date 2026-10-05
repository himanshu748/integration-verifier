const defaultBaseUrl = "https://api.tokenfactory.nebius.com/v1";

export function getTokenFactoryConfig(env = process.env) {
  return {
    baseUrl: env.NEBIUS_BASE_URL || defaultBaseUrl,
    apiKey: env.NEBIUS_API_KEY || "",
    model: env.NEBIUS_MODEL_ID || ""
  };
}

export async function listTokenFactoryModels({ baseUrl, apiKey, verbose = true }) {
  assertApiKey(apiKey);
  assertEndpoint(baseUrl);
  const url = new URL(`${trimTrailingSlash(baseUrl)}/models`);
  if (verbose) url.searchParams.set("verbose", "true");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json"
    }
  });

  const body = await safeJson(response);
  if (!response.ok) {
    throw new TokenFactoryError("models_request_failed", response.status, body);
  }

  if (!Array.isArray(body.data)) {
    throw new TokenFactoryError("models_response_invalid", response.status, body);
  }

  return body.data;
}

export async function runTokenFactoryChat({ baseUrl, apiKey, model, prompt }) {
  assertApiKey(apiKey);
  assertEndpoint(baseUrl);
  if (!model) {
    throw new Error("NEBIUS_MODEL_ID is required for a live chat preflight");
  }

  const response = await fetch(`${trimTrailingSlash(baseUrl)}/chat/completions`, {
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 64,
      temperature: 0
    })
  });

  const body = await safeJson(response);
  if (!response.ok) {
    throw new TokenFactoryError("chat_request_failed", response.status, body);
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0 || body.model !== model || body.choices?.[0]?.finish_reason !== 'stop') {
    throw new TokenFactoryError("chat_response_invalid", response.status, body);
  }

  return { model, content, rawObject: body.object || null };
}

export function chooseCandidateModel(models, preferredModel = "") {
  if (preferredModel) {
    return models.find((model) => model.id === preferredModel) || null;
  }

  return models.find((model) => /nemotron|nvidia/i.test(model.id || model.name || "")) || null;
}

export class TokenFactoryError extends Error {
  constructor(code, status, body) {
    super(`${code}${status ? ` (${status})` : ""}`);
    this.name = "TokenFactoryError";
    this.code = code;
    this.status = status;
    // Raw provider bodies can echo credentials or private request data.
    this.body = { providerError: true };
  }
}

function assertApiKey(apiKey) {
  if (!apiKey) {
    throw new Error("NEBIUS_API_KEY is required");
  }
}

function assertEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || trimTrailingSlash(baseUrl) !== defaultBaseUrl) throw new Error('Use the official Nebius Token Factory endpoint.');
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { parseError: true, text };
  }
}
