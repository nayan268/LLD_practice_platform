/* ===========================================================================
 * LDD Practice Lab — LLM evaluation client
 * Exposes window.LLM with: getSettings, saveSettings, isConfigured, evaluate.
 *
 * Three modes:
 *   - byok + openai     : POST to OpenAI Chat Completions directly
 *   - byok + anthropic  : POST to Anthropic Messages directly
 *   - proxy             : POST the attempt to a local proxy that holds the key
 *
 * The model is asked to return STRICT JSON matching RUBRIC_SCHEMA so the UI can
 * render scores + suggestions reliably.
 * ======================================================================== */

(function () {
  "use strict";

  const SETTINGS_KEY = "ldd-lab:llm-settings";

  const DEFAULTS = {
    mode: "byok",            // "byok" | "proxy"
    provider: "gemini",      // "openai" | "anthropic" | "gemini"
    model: "gemini-3.8-flash",
    apiKey: "",
    proxyUrl: "http://localhost:8787/evaluate"
  };

  // Dimensions the model scores (each 0-10). Kept here so UI + prompt agree.
  const RUBRIC = [
    { key: "requirements", label: "Requirements completeness" },
    { key: "entities",     label: "Entity / class modeling" },
    { key: "classDiagram", label: "Class diagram quality" },
    { key: "interactions", label: "Interactions (sequence/state)" },
    { key: "codeQuality",  label: "Code quality & OOP design" },
    { key: "extensibility",label: "Extensibility & patterns" }
  ];

  // In-memory fallback so settings work for the session even when localStorage
  // is blocked (e.g. opened via file://).
  let memSettings = null;

  function getSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (_) { /* fall through to memory */ }
    return Object.assign({}, DEFAULTS, memSettings || {});
  }

  function saveSettings(s) {
    const merged = Object.assign(getSettings(), s);
    memSettings = merged;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged)); }
    catch (_) { /* opaque origin / disabled storage — keep in memory only */ }
    return merged;
  }

  function isConfigured() {
    const s = getSettings();
    if (s.provider === "kiro") return true;   // manual mode needs no key/endpoint
    if (s.mode === "proxy") return !!s.proxyUrl;
    return !!(s.apiKey && s.model && s.provider);
  }

  // Full prompt (system + user) for manual copy/paste into the Kiro IDE chat.
  function buildPrompt(payload) {
    return buildSystemPrompt() + "\n\n" + buildUserPrompt(payload);
  }

  /* ---------------------- Prompt construction ---------------------- */
  function buildSystemPrompt() {
    return [
      "You are a senior software engineer and interviewer grading a candidate's",
      "LOW-LEVEL DESIGN (LLD) solution to a given problem.",
      "Evaluate the candidate's requirements, entity model, UML diagrams (Mermaid),",
      "and code. Be specific, fair, and constructive. Reward correct use of OOP",
      "principles, design patterns, clear responsibilities, and extensibility.",
      "Penalize god classes, missing abstractions, unclear ownership, and gaps vs the problem scope.",
      "",
      "Return ONLY valid minified JSON (no markdown fences, no prose) with this shape:",
      "{",
      '  "overall": <int 0-100>,',
      '  "verdict": "<one or two sentence summary>",',
      '  "scores": {',
      RUBRIC.map(r => `    "${r.key}": { "score": <int 0-10>, "comment": "<short>" }`).join(",\n"),
      "  },",
      '  "strengths": ["<point>", ...],',
      '  "improvements": ["<actionable suggestion>", ...]',
      "}",
      "Keep each comment under 240 characters. 3-6 strengths and 3-8 improvements."
    ].join("\n");
  }

  function buildUserPrompt(payload) {
    const p = payload;
    const section = (title, body) =>
      `### ${title}\n${(body && body.trim()) ? body.trim() : "(empty)"}\n`;
    const diag = (title, body) =>
      (body && body.trim()) ? `### ${title} (Mermaid)\n\`\`\`\n${body.trim()}\n\`\`\`\n` : "";

    const filesSection = (files) => {
      const list = (files || []).filter((f) => f && (f.content || "").trim());
      if (!list.length) return "### Code\n(no files)\n";
      const tree = list.map((f) => "  - " + f.path).join("\n");
      const bodies = list.map((f) =>
        `#### ${f.path}\n\`\`\`\n${(f.content || "").trim()}\n\`\`\``).join("\n\n");
      return `### Code (${list.length} file${list.length > 1 ? "s" : ""})\nProject tree:\n${tree}\n\n${bodies}\n`;
    };

    return [
      `# Problem: ${p.problemTitle} (difficulty: ${p.difficulty})`,
      p.problemBrief ? `\n${p.problemBrief}\n` : "",
      "\n# Candidate submission\n",
      section("Actors", p.requirements.actors),
      section("Functional requirements", p.requirements.functional),
      section("Non-functional requirements", p.requirements.nonfunctional),
      section("Core entities", p.requirements.entities),
      section("APIs / methods", p.requirements.apis),
      section("Assumptions", p.requirements.assumptions),
      diag("Class diagram", p.diagrams.class),
      diag("Sequence diagram", p.diagrams.sequence),
      diag("State diagram", p.diagrams.state),
      diag("ER diagram", p.diagrams.er),
      filesSection(p.files),
      "\nGrade strictly against the problem. Consider the project's file/folder",
      "structure (separation of concerns, package layout) as part of the design.",
      "Respond with JSON only."
    ].join("\n");
  }

  /* ---------------------- Provider calls ---------------------- */
  async function callOpenAI(s, system, user) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + s.apiKey
      },
      body: JSON.stringify({
        model: s.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await safeErr(res)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async function callAnthropic(s, system, user) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: s.model,
        max_tokens: 1500,
        temperature: 0.2,
        system: system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await safeErr(res)}`);
    const data = await res.json();
    return (data.content && data.content[0] && data.content[0].text) || "";
  }

  async function callGemini(s, system, user) {
    // Gemini REST: systemInstruction + contents; ask for JSON output directly.
    const model = encodeURIComponent(s.model);
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(s.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await safeErr(res)}`);
    const data = await res.json();
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new Error("Gemini blocked the prompt: " + data.promptFeedback.blockReason);
    }
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").join("");
  }

  async function callProxy(s, system, user, payload) {
    const res = await fetch(s.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, user, payload })
    });
    if (!res.ok) throw new Error(`Proxy ${res.status}: ${await safeErr(res)}`);
    const data = await res.json();
    // proxy may return {content} or already-parsed {result}
    if (data.result) return JSON.stringify(data.result);
    return data.content || "";
  }

  async function safeErr(res) {
    try { return (await res.text()).slice(0, 300); } catch (_) { return "(no body)"; }
  }

  /* ---------------------- Parsing ---------------------- */
  function parseResult(text) {
    if (!text) throw new Error("Empty response from model.");
    // Strip accidental code fences.
    let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    // Grab the outermost JSON object if there's surrounding prose.
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error("Could not parse model JSON. Raw:\n" + text.slice(0, 800));
    }
    // normalize
    obj.scores = obj.scores || {};
    obj.strengths = obj.strengths || [];
    obj.improvements = obj.improvements || [];
    if (typeof obj.overall !== "number") {
      // derive from dimensions if missing
      const vals = RUBRIC.map(r => (obj.scores[r.key] && obj.scores[r.key].score) || 0);
      const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      obj.overall = Math.round(avg * 10);
    }
    return obj;
  }

  /* ---------------------- Public evaluate ---------------------- */
  async function evaluate(payload) {
    const s = getSettings();
    const system = buildSystemPrompt();
    const user = buildUserPrompt(payload);

    let raw;
    if (s.mode === "proxy") {
      raw = await callProxy(s, system, user, payload);
    } else if (s.provider === "anthropic") {
      raw = await callAnthropic(s, system, user);
    } else if (s.provider === "gemini") {
      raw = await callGemini(s, system, user);
    } else {
      raw = await callOpenAI(s, system, user);
    }
    return parseResult(raw);
  }

  window.LLM = {
    RUBRIC,
    getSettings,
    saveSettings,
    isConfigured,
    evaluate,
    buildPrompt,        // combined system+user prompt (Kiro manual mode)
    parse: parseResult, // parse a pasted result JSON into the rubric object
    _buildUserPrompt: buildUserPrompt
  };
})();
