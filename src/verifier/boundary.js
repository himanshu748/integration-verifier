import http from "node:http";
import { randomUUID } from "node:crypto";

export async function startBoundary({ scenario, port = 0 }) {
  if (!["marker", "provider-fail", "malformed"].includes(scenario)) {
    throw new Error(`Unsupported scenario: ${scenario}`);
  }
  const requests = [];
  const marker = `VERIFIER_MARKER_${randomUUID()}`;

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");

    requests.push({
      method: request.method,
      url: request.url,
      authorizationPresent: Boolean(request.headers.authorization),
      body: safeJson(bodyText)
    });

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (scenario === "provider-fail") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic_provider_failure" }));
      return;
    }

    if (scenario === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [] }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-verifier",
      object: "chat.completion",
      model: "nvidia/test-nemotron",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `Synthetic provider response ${marker}`
          },
          finish_reason: "stop"
        }
      ]
    }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    marker,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { parseError: true, raw: text };
  }
}
