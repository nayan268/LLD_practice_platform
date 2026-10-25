/* ===========================================================================
 * LDD Practice Lab — local server
 *
 * Does three things, with no npm dependencies (plain Node http, Node 18+):
 *   1. Serves the static app (so the app + saves share ONE origin).
 *   2. Durable per-problem saves on disk under ./saves/<problemId>.json.
 *   3. Optional LLM evaluation proxy (keeps your API key server-side).
 *
 * Run it:
 *   node proxy-server.js
 *   # then open http://localhost:8787/  (app + saving both work here)
 *
 * For LLM evaluation via the proxy, also set a provider + key, e.g. (PowerShell):
 *   $env:LLM_PROVIDER="gemini"; $env:GEMINI_API_KEY="..."; node proxy-server.js
 *   $env:LLM_PROVIDER="openai"; $env:OPENAI_API_KEY="sk-..."; node proxy-server.js
 *   $env:LLM_PROVIDER="anthropic"; $env:ANTHROPIC_API_KEY="sk-ant-..."; node proxy-server.js
 * (bash: LLM_PROVIDER=gemini GEMINI_API_KEY=... node proxy-server.js)
 *
 * The server starts for SAVING even with no API key — the key is only needed
 * when you actually use the /evaluate proxy.
 *
 * Save API:
 *   GET    /save/:id   -> { id, data } | 404
 *   POST   /save/:id   body: { data }  -> { ok:true }
 *   DELETE /save/:id   -> { ok:true }
 *   GET    /saves      -> { ids: [...] }
 *
 * Env vars:
 *   PORT              (default 8787)
 *   LLM_PROVIDER      "gemini" | "openai" | "anthropic"   (default gemini)
 *   LLM_MODEL         model name (defaults per provider)
 *   GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
 * ======================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const MODEL = process.env.LLM_MODEL || ({
  anthropic: "claude-3-5-sonnet-latest",
  gemini: "gemini-3.8-flash",
  openai: "gpt-4o-mini"
})[PROVIDER] || "gpt-4o-mini";

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

const ROOT = __dirname;
const SAVES_DIR = path.join(ROOT, "saves");

if (typeof fetch !== "function") {
  console.warn("Note: global fetch not found (Node < 18). Saving still works; " +
    "the /evaluate proxy will not.");
}

/* ---------------------- helpers ---------------------- */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); }); // 5MB guard
  req.on("end", () => cb(body));
}
// Only allow simple problem-id slugs, so paths can't escape ./saves.
function safeId(id) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(id) ? id : null;
}
function ensureSavesDir() {
  try { fs.mkdirSync(SAVES_DIR, { recursive: true }); } catch (_) {}
}

/* ---------------------- static file serving ---------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".map": "application/json"
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // prevent path traversal
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---------------------- LLM proxy ---------------------- */
async function callOpenAI(system, user) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set on the server.");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
    body: JSON.stringify({
      model: MODEL, temperature: 0.2, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}
async function callAnthropic(system, user) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set on the server.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, temperature: 0.2, system, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || "";
}
async function callGemini(system, user) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set on the server.");
  const model = encodeURIComponent(MODEL);
  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
    })
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error("Gemini blocked the prompt: " + data.promptFeedback.blockReason);
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

/* ---------------------- router ---------------------- */
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  const url = req.url || "/";

  // --- health ---
  if (req.method === "GET" && url === "/health") {
    return sendJson(res, 200, {
      ok: true, provider: PROVIDER, model: MODEL,
      saving: true, savesDir: "saves"
    });
  }

  // --- list saves ---
  if (req.method === "GET" && url === "/saves") {
    ensureSavesDir();
    fs.readdir(SAVES_DIR, (err, files) => {
      if (err) return sendJson(res, 200, { ids: [] });
      const ids = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
      sendJson(res, 200, { ids });
    });
    return;
  }

  // --- per-problem save routes: /save/<id> ---
  if (url.startsWith("/save/")) {
    const id = safeId(url.slice("/save/".length).split("?")[0]);
    if (!id) return sendJson(res, 400, { error: "Invalid id" });
    const file = path.join(SAVES_DIR, id + ".json");

    if (req.method === "GET") {
      fs.readFile(file, "utf8", (err, txt) => {
        if (err) return sendJson(res, 404, { error: "No save for " + id });
        let data;
        try { data = JSON.parse(txt); } catch (_) { data = null; }
        sendJson(res, 200, { id, data });
      });
      return;
    }

    if (req.method === "POST") {
      readBody(req, (body) => {
        let payload;
        try { payload = JSON.parse(body || "{}"); }
        catch (_) { return sendJson(res, 400, { error: "Invalid JSON body" }); }
        const data = payload.data !== undefined ? payload.data : payload;
        ensureSavesDir();
        fs.writeFile(file, JSON.stringify(data, null, 2), (err) => {
          if (err) return sendJson(res, 500, { error: String(err.message || err) });
          sendJson(res, 200, { ok: true, id });
        });
      });
      return;
    }

    if (req.method === "DELETE") {
      fs.unlink(file, () => sendJson(res, 200, { ok: true, id }));
      return;
    }

    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // --- LLM evaluation proxy ---
  if (req.method === "POST" && url.startsWith("/evaluate")) {
    readBody(req, async (body) => {
      try {
        const { system, user } = JSON.parse(body || "{}");
        if (!system || !user) return sendJson(res, 400, { error: "Expected { system, user }" });
        if (typeof fetch !== "function") throw new Error("Server Node lacks fetch (need Node 18+).");
        const content = PROVIDER === "anthropic" ? await callAnthropic(system, user)
          : PROVIDER === "gemini" ? await callGemini(system, user)
          : await callOpenAI(system, user);
        sendJson(res, 200, { content });
      } catch (err) {
        console.error(err);
        sendJson(res, 502, { error: String(err.message || err) });
      }
    });
    return;
  }

  // --- otherwise: serve static app files ---
  if (req.method === "GET") return serveStatic(req, res, url);

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  ensureSavesDir();
  console.log(`LDD Practice Lab server → http://localhost:${PORT}/`);
  console.log(`  • App served from this folder (open the URL above)`);
  console.log(`  • Saves persisted to ./saves/<problem>.json`);
  console.log(`  • LLM proxy at /evaluate (provider=${PROVIDER}, model=${MODEL}${
    (PROVIDER === "gemini" && !GEMINI_KEY) || (PROVIDER === "openai" && !OPENAI_KEY) ||
    (PROVIDER === "anthropic" && !ANTHROPIC_KEY) ? ", no key set — proxy disabled" : ""})`);
});
