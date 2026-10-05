import http from "node:http";

const appMode = process.env.SAMPLE_APP || "honest-live";
const providerBaseUrl = process.env.PROVIDER_BASE_URL || "http://127.0.0.1:4101";
const port = Number(process.env.PORT || 4100);

async function callProvider(prompt) {
  const response = await fetch(`${providerBaseUrl}/v1/chat/completions`, {
    signal: AbortSignal.timeout(10000),
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.APP_AI_KEY || "test-key"}`
    },
    body: JSON.stringify({
      model: process.env.APP_MODEL || "nvidia/test-nemotron",
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    throw new Error(`provider_status_${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("provider_missing_content");
  }
  return content;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

async function handleChat(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const prompt = String(body.prompt || "");

  if (appMode === "honest-live") {
    const answer = await callProvider(prompt);
    return sendJson(response, 200, {
      answer,
      status: "live",
      disclosure: "provider response displayed"
    });
  }

  if (appMode === "fake-fallback") {
    try {
      const answer = await callProvider(prompt);
      return sendJson(response, 200, {
        answer,
        status: "live",
        disclosure: "provider response displayed"
      });
    } catch {
      return sendJson(response, 200, {
        answer: "Live AI answer: your plan is ready. MOCK_DATA_FALLBACK",
        status: "live",
        disclosure: "provider response displayed"
      });
    }
  }

  if (appMode === "declared-fallback") {
    try {
      const answer = await callProvider(prompt);
      return sendJson(response, 200, {
        answer,
        status: "live",
        disclosure: "provider response displayed"
      });
    } catch {
      return sendJson(response, 503, {
        answer: "Fallback mode: provider unavailable, so this response is not live AI.",
        status: "fallback",
        disclosure: "provider unavailable; fallback disclosed"
      });
    }
  }

  return sendJson(response, 500, { error: `unknown sample app: ${appMode}` });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${appMode}</title></head>
  <body>
    <main>
      <h1>${appMode}</h1>
      <form id="chat-form">
        <label>Prompt <input name="prompt" value="write a launch checklist"></label>
        <button type="submit">Generate</button>
      </form>
      <pre id="result"></pre>
      <script>
        document.querySelector("#chat-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const prompt = new FormData(event.currentTarget).get("prompt");
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt })
          });
          document.querySelector("#result").textContent = JSON.stringify(await response.json(), null, 2);
        });
      </script>
    </main>
  </body>
</html>`);
      return;
    }

    if (request.method === "POST" && request.url === "/api/chat") {
      await handleChat(request, response);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  const ready = { event: "sample_app_ready", appMode, port: server.address().port };
  console.log(JSON.stringify(ready));
  process.send?.(ready);
});
