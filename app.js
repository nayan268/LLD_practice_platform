/* ===========================================================================
 * LDD Practice Lab — App Logic
 * ======================================================================== */

(function () {
  "use strict";

  const STORAGE_PREFIX = "ldd-lab:";
  const DIAGRAM_KINDS = ["class", "sequence", "state", "er"];
  const REQ_FIELDS = [
    "req-actors", "req-functional", "req-nonfunctional",
    "req-entities", "req-apis", "req-assumptions"
  ];

  // Starter templates shown when a diagram editor is empty.
  const TEMPLATES = {
    class: `classDiagram
    class Example {
      +String name
      +doThing() void
    }
    Example <|-- SubType`,
    sequence: `sequenceDiagram
    actor User
    participant System
    User->>System: request()
    System-->>User: response`,
    state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Active : start
    Active --> Idle : stop`,
    er: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER {
      string id PK
      string name
    }
    ORDER {
      string id PK
      string customer_id FK
    }`
  };

  let currentProblemId = null;
  let timerSeconds = 0;
  let timerHandle = null;
  let mermaidReady = false;
  let codeEditor = null; // CodeMirror instance
  // Virtual project: files is an ordered map path -> content; activeFile is a path.
  let project = { files: {}, activeFile: null };

  /* -------------------------- DOM helpers -------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1600);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /* -------------------------- Persistence -------------------------- */
  // localStorage throws on file:// (opaque origin) and when storage is disabled.
  // Wrap every access so the app still runs (just without persistence).
  let storageWarned = false;
  const safeStore = {
    get(key) {
      try { return localStorage.getItem(key); }
      catch (_) { warnOnce(); return null; }
    },
    set(key, val) {
      try { localStorage.setItem(key, val); return true; }
      catch (_) { warnOnce(); return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); }
      catch (_) { warnOnce(); }
    }
  };
  function warnOnce() {
    if (storageWarned) return;
    storageWarned = true;
    console.warn("localStorage unavailable (opened via file://?). Work won't persist. " +
      "Serve the folder over http:// to enable saving.");
  }

  function storageKey(problemId) {
    return STORAGE_PREFIX + problemId;
  }

  // --- Server-backed durable saves (same-origin proxy-server.js) -----------
  // When the app is served by proxy-server.js, saves are written to disk under
  // ./saves/<id>.json so they survive restarts and are shared across browsers.
  // localStorage is still used as a fast local cache + offline fallback.
  const SERVER = {
    available: false,          // set by probeServer() at boot
    base: "",                  // same origin
    probed: false
  };

  async function probeServer() {
    try {
      const r = await fetch("/health", { method: "GET" });
      if (r.ok) {
        const j = await r.json();
        SERVER.available = !!(j && j.saving);
      }
    } catch (_) { SERVER.available = false; }
    SERVER.probed = true;
    updateSaveHint();
  }

  // Fetch a problem's saved work from the server. Resolves to object or null.
  async function serverLoad(problemId) {
    if (!SERVER.available) return null;
    try {
      const r = await fetch("/save/" + encodeURIComponent(problemId));
      if (r.status === 404) return null;
      if (!r.ok) return null;
      const j = await r.json();
      return (j && j.data) ? j.data : null;
    } catch (_) { return null; }
  }

  // Write-through to the server (fire-and-forget; returns a promise<bool>).
  async function serverSave(problemId, data) {
    if (!SERVER.available) return false;
    try {
      const r = await fetch("/save/" + encodeURIComponent(problemId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data })
      });
      return r.ok;
    } catch (_) { return false; }
  }

  async function serverRemove(problemId) {
    if (!SERVER.available) return;
    try { await fetch("/save/" + encodeURIComponent(problemId), { method: "DELETE" }); }
    catch (_) {}
  }

  // Synchronous local read (fast first paint / offline).
  function loadWork(problemId) {
    const raw = safeStore.get(storageKey(problemId));
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch (_) { return {}; }
  }

  function saveWork(problemId, data, silent) {
    const localOk = safeStore.set(storageKey(problemId), JSON.stringify(data));
    if (SERVER.available) {
      serverSave(problemId, data).then((ok) => {
        if (!silent) toast(ok ? "Saved to disk" : "Saved locally (server write failed)");
      });
      if (!silent && !SERVER.probed) toast("Saving…");
    } else if (!silent) {
      toast(localOk
        ? "Saved in this browser (run the server for durable disk saves)"
        : "Not saved — serve over http:// or run the server");
    }
  }

  function collectWork() {
    const work = { requirements: {}, diagrams: {}, checklist: {} };
    REQ_FIELDS.forEach((id) => { work.requirements[id] = $("#" + id).value; });
    DIAGRAM_KINDS.forEach((kind) => {
      const ta = $(`.diagram-editor[data-kind="${kind}"] textarea`);
      if (ta) work.diagrams[kind] = ta.value;
    });
    $$("#checklist input[type=checkbox]").forEach((cb, i) => {
      work.checklist[i] = cb.checked;
    });
    syncActiveFile();
    work.project = { files: project.files, activeFile: project.activeFile };
    return work;
  }

  function persist(silent = true) {
    if (!currentProblemId) return;
    saveWork(currentProblemId, collectWork(), silent);
  }

  const persistDebounced = debounce(() => persist(true), 500);

  /* -------------------------- Problem brief -------------------------- */
  function getProblem(id) {
    return window.PROBLEMS.find((p) => p.id === id);
  }

  function renderProblem(problem) {
    $("#problem-title").textContent = problem.title;
    const diff = $("#problem-difficulty");
    diff.textContent = problem.difficulty;
    diff.className = "pill " + problem.difficulty;

    const scope = (problem.scope || [])
      .map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    const hints = (problem.hints || [])
      .map((h) => `<div class="hint">💡 ${escapeHtml(h)}</div>`).join("");

    $("#problem-body").innerHTML = `
      <p>${escapeHtml(problem.brief)}</p>
      <h3>In scope</h3>
      <ul>${scope}</ul>
      <details class="hints">
        <summary>Show hints (${(problem.hints || []).length})</summary>
        ${hints}
      </details>
    `;
  }

  /* -------------------------- Checklist -------------------------- */
  function renderChecklist(problem, saved) {
    const ul = $("#checklist");
    ul.innerHTML = "";
    (problem.checklist || []).forEach((item, i) => {
      const li = document.createElement("li");
      const checked = saved && saved.checklist && saved.checklist[i] ? "checked" : "";
      li.innerHTML = `
        <input type="checkbox" id="chk-${i}" ${checked} />
        <label for="chk-${i}">${escapeHtml(item)}</label>`;
      ul.appendChild(li);
    });
    ul.addEventListener("change", () => {
      updateChecklistScore(problem);
      persistDebounced();
    });
    updateChecklistScore(problem);
  }

  function updateChecklistScore(problem) {
    const total = (problem.checklist || []).length;
    const done = $$("#checklist input:checked").length;
    $("#checklist-score").textContent = total ? `(${done}/${total})` : "";
  }

  /* -------------------------- Diagram editors -------------------------- */
  function buildDiagramEditors() {
    DIAGRAM_KINDS.forEach((kind) => {
      const host = $(`.diagram-editor[data-kind="${kind}"]`);
      if (host.dataset.built) return;
      host.dataset.built = "1";
      host.innerHTML = `
        <div class="diagram-toolbar">
          <span class="label">${kindLabel(kind)} — live preview</span>
          <button class="btn btn-small" data-act="template">Insert template</button>
          <button class="btn btn-small" data-act="clear">Clear</button>
        </div>
        <div class="diagram-split">
          <div class="diagram-code">
            <textarea spellcheck="false" placeholder="Write Mermaid ${kind} syntax..."></textarea>
          </div>
          <div class="diagram-preview"><div class="ph muted">Preview appears here as you type.</div></div>
        </div>`;

      const ta = $("textarea", host);
      const preview = $(".diagram-preview", host);

      const render = debounce(() => renderMermaid(kind, ta.value, preview), 350);
      ta.addEventListener("input", () => { render(); persistDebounced(); });

      $('[data-act="template"]', host).addEventListener("click", () => {
        ta.value = TEMPLATES[kind];
        renderMermaid(kind, ta.value, preview);
        persist(false);
      });
      $('[data-act="clear"]', host).addEventListener("click", () => {
        ta.value = "";
        preview.innerHTML = '<div class="ph muted">Cleared.</div>';
        persist(false);
      });
    });
  }

  function kindLabel(kind) {
    return { class: "Class diagram", sequence: "Sequence diagram",
      state: "State diagram", er: "ER diagram" }[kind] || kind;
  }

  let renderSeq = 0;
  async function renderMermaid(kind, code, container) {
    if (!code.trim()) {
      container.innerHTML = '<div class="ph muted">Preview appears here as you type.</div>';
      return;
    }
    if (!mermaidReady) {
      container.innerHTML = '<div class="ph muted">Loading diagram engine…</div>';
      return;
    }
    const id = `mmd-${kind}-${++renderSeq}`;
    try {
      const { svg } = await window.mermaid.render(id, code);
      container.innerHTML = svg;
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      container.innerHTML = `<div class="diagram-error">⚠ Diagram error:\n${escapeHtml(msg)}</div>`;
    }
  }

  function rerenderActiveDiagram() {
    const activePane = $(".tab-pane.active");
    if (!activePane) return;
    const host = $(".diagram-editor", activePane);
    if (!host) return;
    const kind = host.dataset.kind;
    const ta = $("textarea", host);
    const preview = $(".diagram-preview", host);
    if (ta && preview) renderMermaid(kind, ta.value, preview);
  }

  /* -------------------------- Tabs -------------------------- */
  function initTabs() {
    $("#workspace-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;
      const tab = btn.dataset.tab;
      $$(".tab").forEach((t) => t.classList.toggle("active", t === btn));
      $$(".tab-pane").forEach((p) =>
        p.classList.toggle("active", p.dataset.pane === tab));
      // (Re)render the diagram that just became visible so sizing is correct.
      if (DIAGRAM_KINDS.includes(tab)) rerenderActiveDiagram();
      // CodeMirror must refresh once its container is visible.
      if (tab === "code" && codeEditor) setTimeout(() => codeEditor.refresh(), 0);
    });
  }

  /* -------------------------- Solution reveal -------------------------- */
  function renderSolution(problem) {
    const content = $("#solution-content");
    const notes = (problem.solution.notes || [])
      .map((n) => `<li>${escapeHtml(n)}</li>`).join("");
    let html = `<h3>Design notes</h3><ul>${notes}</ul>`;
    DIAGRAM_KINDS.forEach((kind) => {
      const code = problem.solution.diagrams[kind];
      if (!code) return;
      html += `<h3>${kindLabel(kind)}</h3>
        <div class="solution-diagram" data-sol="${kind}"></div>`;
    });
    content.innerHTML = html;

    // reset reveal state for each problem switch
    content.classList.add("hidden");
    $("#solution-locked").classList.remove("hidden");
    $("#toggle-solution").textContent = "Reveal";
    content.dataset.rendered = "";
  }

  async function revealSolutionDiagrams(problem) {
    const content = $("#solution-content");
    if (content.dataset.rendered === "1" || !mermaidReady) return;
    content.dataset.rendered = "1";
    for (const kind of DIAGRAM_KINDS) {
      const code = problem.solution.diagrams[kind];
      const slot = $(`.solution-diagram[data-sol="${kind}"]`, content);
      if (code && slot) {
        try {
          const { svg } = await window.mermaid.render(`sol-${kind}-${Date.now()}`, code);
          slot.innerHTML = svg;
        } catch (err) {
          slot.innerHTML = `<div class="diagram-error">${escapeHtml(String(err))}</div>`;
        }
      }
    }
  }

  function initSolutionToggle() {
    $("#toggle-solution").addEventListener("click", () => {
      const content = $("#solution-content");
      const locked = $("#solution-locked");
      const nowHidden = content.classList.toggle("hidden");
      locked.classList.toggle("hidden", !nowHidden);
      $("#toggle-solution").textContent = nowHidden ? "Reveal" : "Hide";
      if (!nowHidden) revealSolutionDiagrams(getProblem(currentProblemId));
    });
  }

  /* -------------------------- Load a problem -------------------------- */
  // Populate all workspace fields from a saved-work object.
  function applySavedWork(problem, saved) {
    renderChecklist(problem, saved);

    REQ_FIELDS.forEach((id) => {
      $("#" + id).value = (saved.requirements && saved.requirements[id]) || "";
    });

    DIAGRAM_KINDS.forEach((kind) => {
      const ta = $(`.diagram-editor[data-kind="${kind}"] textarea`);
      if (!ta) return;
      ta.value = (saved.diagrams && saved.diagrams[kind]) || "";
      const preview = $(`.diagram-editor[data-kind="${kind}"] .diagram-preview`);
      renderMermaid(kind, ta.value, preview);
    });

    loadProjectFromSaved(saved);
  }

  function loadProblem(problemId) {
    // persist outgoing work first
    if (currentProblemId) persist(true);
    currentProblemId = problemId;

    const problem = getProblem(problemId);
    const localSaved = loadWork(problemId);

    renderProblem(problem);
    renderSolution(problem);
    applySavedWork(problem, localSaved);     // fast first paint from local cache

    // clear any previous evaluation result
    resetEvaluation();

    // reset to requirements tab
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "requirements"));
    $$(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === "requirements"));

    safeStore.set(STORAGE_PREFIX + "last", problemId);

    // Then pull the durable server copy; if present, it wins and repaints.
    if (SERVER.available) {
      serverLoad(problemId).then((serverSaved) => {
        if (!serverSaved) return;
        if (currentProblemId !== problemId) return; // user switched away
        // mirror into local cache and repaint
        safeStore.set(storageKey(problemId), JSON.stringify(serverSaved));
        applySavedWork(problem, serverSaved);
        if ($("#save-hint")) $("#save-hint").textContent = "Loaded saved work from disk.";
      });
    }
  }

  /* -------------------------- Export -------------------------- */
  function exportMarkdown() {
    const problem = getProblem(currentProblemId);
    const w = collectWork();
    const r = w.requirements;
    const lines = [];
    lines.push(`# LDD Attempt — ${problem.title}`);
    lines.push(`\n_Difficulty: ${problem.difficulty} · exported ${new Date().toLocaleString()}_\n`);
    const section = (title, body) => {
      lines.push(`## ${title}\n`);
      lines.push((body && body.trim()) ? body.trim() : "_(empty)_");
      lines.push("");
    };
    section("Actors / Users", r["req-actors"]);
    section("Functional Requirements", r["req-functional"]);
    section("Non-Functional Requirements", r["req-nonfunctional"]);
    section("Core Entities", r["req-entities"]);
    section("APIs / Core Methods", r["req-apis"]);
    section("Assumptions & Constraints", r["req-assumptions"]);

    DIAGRAM_KINDS.forEach((kind) => {
      const code = w.diagrams[kind];
      if (code && code.trim()) {
        lines.push(`## ${kindLabel(kind)}\n`);
        lines.push("```mermaid\n" + code.trim() + "\n```\n");
      }
    });

    const files = projectFileList();
    if (files.length) {
      lines.push("## Code\n");
      files.forEach((f) => {
        lines.push(`**\`${f.path}\`**\n`);
        lines.push("```" + fenceFor(f.path) + "\n" + (f.content || "").replace(/\s+$/, "") + "\n```\n");
      });
    }

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ldd-${problem.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Exported Markdown");
  }

  /* -------------------------- Timer -------------------------- */
  function fmtTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }
  function toggleTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
      toast("Timer paused");
    } else {
      timerHandle = setInterval(() => {
        timerSeconds++;
        $("#timer").textContent = fmtTime(timerSeconds);
      }, 1000);
      toast("Timer started");
    }
  }

  /* -------------------------- Misc -------------------------- */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function populateProblemSelect() {
    const sel = $("#problem-select");
    window.PROBLEMS.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.title}  ·  ${p.difficulty}`;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => loadProblem(sel.value));
  }

  function initRequirementListeners() {
    REQ_FIELDS.forEach((id) => {
      $("#" + id).addEventListener("input", persistDebounced);
    });
  }

  function initHeaderButtons() {
    $("#save-btn").addEventListener("click", () => persist(false));
    $("#export-btn").addEventListener("click", exportMarkdown);
    $("#timer-btn").addEventListener("click", toggleTimer);
    $("#reset-btn").addEventListener("click", () => {
      if (!currentProblemId) return;
      if (!confirm("Clear all your saved work for this problem?")) return;
      const id = currentProblemId;
      safeStore.remove(storageKey(id));
      serverRemove(id);            // also delete the durable disk copy
      loadProblem(id);
      toast("Work cleared");
    });
  }

  // Small status line under the header buttons reflecting where saves go.
  function updateSaveHint() {
    const el = $("#save-hint");
    if (!el) return;
    el.textContent = SERVER.available
      ? "Durable saves on (writing to disk via server)."
      : "Browser-only saves. Run the server for durable disk saves.";
  }

  /* -------------------------- Code project (multi-file) -------------------------- */
  // Map file extension -> CodeMirror mode + markdown fence language.
  const EXT_MAP = {
    java: { mode: "text/x-java", fence: "java" },
    py:   { mode: "text/x-python", fence: "python" },
    js:   { mode: "text/javascript", fence: "javascript" },
    jsx:  { mode: "text/javascript", fence: "javascript" },
    ts:   { mode: "text/typescript", fence: "typescript" },
    tsx:  { mode: "text/typescript", fence: "typescript" },
    cpp:  { mode: "text/x-c++src", fence: "cpp" },
    cc:   { mode: "text/x-c++src", fence: "cpp" },
    h:    { mode: "text/x-c++src", fence: "cpp" },
    hpp:  { mode: "text/x-c++src", fence: "cpp" },
    c:    { mode: "text/x-csrc", fence: "c" },
    cs:   { mode: "text/x-csharp", fence: "csharp" },
    go:   { mode: "text/x-go", fence: "go" },
    json: { mode: "application/json", fence: "json" },
    md:   { mode: "text/plain", fence: "md" },
    txt:  { mode: "text/plain", fence: "" }
  };

  function extOf(path) {
    const base = path.split("/").pop() || "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  }
  function modeFor(path) { return (EXT_MAP[extOf(path)] || {}).mode || "text/plain"; }
  function fenceFor(path) { return (EXT_MAP[extOf(path)] || {}).fence || ""; }
  function iconFor(path) { return path.endsWith("/") ? "📁" : "📄"; }

  // Normalize a user-entered path: trim, strip leading slashes, collapse dupes.
  function normPath(p) {
    return String(p).trim().replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  }

  /* ---- Autocomplete: per-language keyword/library word lists ---- */
  // Map file extension -> hint language bucket.
  const HINT_LANG = {
    java: "java",
    py: "python",
    cpp: "cpp", cc: "cpp", h: "cpp", hpp: "cpp", c: "cpp"
  };

  const KEYWORDS = {
    java: [
      // keywords / modifiers
      "abstract","assert","boolean","break","byte","case","catch","char","class",
      "const","continue","default","do","double","else","enum","extends","final",
      "finally","float","for","if","implements","import","instanceof","int",
      "interface","long","native","new","package","private","protected","public",
      "return","short","static","strictfp","super","switch","synchronized","this",
      "throw","throws","transient","try","void","volatile","while","var","record",
      "sealed","permits","yield","true","false","null",
      // common types / library
      "String","Integer","Long","Double","Boolean","Object","List","ArrayList",
      "LinkedList","Map","HashMap","TreeMap","LinkedHashMap","Set","HashSet",
      "TreeSet","Queue","Deque","Stack","Optional","Collection","Collections",
      "Arrays","Comparator","Comparable","Iterator","Iterable","Exception",
      "RuntimeException","IllegalArgumentException","IllegalStateException",
      "Override","System","Math","StringBuilder","Thread","Runnable","Enum",
      "equals","hashCode","toString","size","isEmpty","add","remove","get","put",
      "contains","containsKey","stream","forEach","println","println"
    ],
    python: [
      // keywords
      "and","as","assert","async","await","break","class","continue","def","del",
      "elif","else","except","finally","for","from","global","if","import","in",
      "is","lambda","nonlocal","not","or","pass","raise","return","try","while",
      "with","yield","True","False","None","match","case","self","cls",
      // builtins / common
      "print","len","range","enumerate","zip","map","filter","sorted","reversed",
      "sum","min","max","abs","round","int","float","str","bool","list","dict",
      "set","tuple","frozenset","type","isinstance","issubclass","super","property",
      "staticmethod","classmethod","dataclass","Enum","Optional","List","Dict",
      "Set","Tuple","Any","Union","Callable","Iterator","Iterable","ABC",
      "abstractmethod","__init__","__repr__","__str__","__eq__","__hash__","append",
      "extend","pop","keys","values","items","get","join","split","format"
    ],
    cpp: [
      // keywords
      "alignas","alignof","auto","bool","break","case","catch","char","class",
      "const","constexpr","continue","decltype","default","delete","do","double",
      "dynamic_cast","else","enum","explicit","export","extern","false","float",
      "for","friend","goto","if","inline","int","long","mutable","namespace","new",
      "noexcept","nullptr","operator","override","private","protected","public",
      "register","reinterpret_cast","return","short","signed","sizeof","static",
      "static_cast","struct","switch","template","this","throw","true","try",
      "typedef","typename","union","unsigned","using","virtual","void","volatile",
      "wchar_t","while",
      // std library
      "std","string","vector","map","unordered_map","set","unordered_set","pair",
      "tuple","array","list","deque","queue","stack","priority_queue","shared_ptr",
      "unique_ptr","make_shared","make_unique","size_t","iostream","cout","cin",
      "endl","push_back","emplace_back","begin","end","size","empty","find",
      "insert","erase","first","second","sort","for_each","to_string","move"
    ]
  };

  // Hybrid hint: merge words already in the file (anyword) with language keywords,
  // filtered by the current token prefix, de-duplicated and sorted.
  function makeHybridHint(hintLang) {
    return function (cm) {
      const CM = window.CodeMirror;
      const cur = cm.getCursor();
      const token = cm.getTokenAt(cur);
      let start = token.start, end = cur.ch;
      const prefix = (token.string || "").slice(0, end - token.start);
      // only trigger on identifier-ish tokens
      const word = /[\w$]+$/.exec(prefix ? prefix : "");
      const typed = word ? word[0] : "";
      start = end - typed.length;

      const seen = new Set();
      const out = [];
      const push = (w) => {
        if (!w || seen.has(w)) return;
        if (typed && !w.toLowerCase().startsWith(typed.toLowerCase())) return;
        if (w === typed) return;
        seen.add(w); out.push(w);
      };

      // 1) words already present in the document
      const docWords = (cm.getValue().match(/[A-Za-z_$][\w$]*/g) || []);
      docWords.forEach(push);
      // 2) language keywords/library
      (KEYWORDS[hintLang] || []).forEach(push);

      out.sort((a, b) => a.localeCompare(b));
      return {
        list: out.slice(0, 60),
        from: CM.Pos(cur.line, start),
        to: CM.Pos(cur.line, end)
      };
    };
  }

  function hintLangFor(path) { return HINT_LANG[extOf(path)] || null; }

  // Called when the active file changes: enable/disable auto-popup hinting.
  function applyHintingFor(path) {
    if (!codeEditor || !window.CodeMirror || !window.CodeMirror.showHint) return;
    const lang = hintLangFor(path);
    codeEditor._hintLang = lang; // used by the keymap + change handler
  }

  function triggerHint(cm) {
    const CM = window.CodeMirror;
    const lang = cm._hintLang;
    if (!lang || !CM.showHint) return;
    CM.showHint(cm, makeHybridHint(lang), { completeSingle: false });
  }

  // Auto-popup while typing identifier characters (not on delete/paste/enter).
  function maybeAutoHint(cm, change) {
    if (!cm._hintLang || !window.CodeMirror || !window.CodeMirror.showHint) return;
    if (cm.state.completionActive) return;        // already open; let it update
    if (!change || change.origin !== "+input") return;
    const typed = change.text && change.text.join("");
    if (!typed || !/[A-Za-z_$]$/.test(typed)) return; // only letters/_/$ trigger
    // require at least 2 identifier chars before the cursor to avoid noise
    const cur = cm.getCursor();
    const before = cm.getRange(window.CodeMirror.Pos(cur.line, 0), cur);
    const m = /[A-Za-z_$][\w$]*$/.exec(before);
    if (!m || m[0].length < 2) return;
    triggerHint(cm);
  }

  function initCodeEditor() {
    const ta = $("#code-area");
    if (ta && window.CodeMirror) {
      codeEditor = window.CodeMirror.fromTextArea(ta, {
        lineNumbers: true,
        theme: "material-darker",
        mode: "text/plain",
        indentUnit: 4,
        tabSize: 4,
        autoCloseBrackets: true,
        lineWrapping: false,
        extraKeys: { "Ctrl-Space": (cm) => triggerHint(cm) }
      });
      codeEditor.on("change", (cm, change) => {
        // keep the in-memory file in sync, then autosave
        if (project.activeFile != null) {
          project.files[project.activeFile] = cm.getValue();
        }
        persistDebounced();
        maybeAutoHint(cm, change);
      });
      codeEditor.setOption("readOnly", true); // until a file is open
    } else if (!window.CodeMirror) {
      console.warn("CodeMirror not loaded; falling back to plain textarea.");
      // Wire the raw textarea so editing still syncs + autosaves.
      if (ta) {
        ta.addEventListener("input", () => {
          if (project.activeFile != null) {
            project.files[project.activeFile] = ta.value;
          }
          persistDebounced();
        });
      }
    }

    $("#new-file-btn").addEventListener("click", () => createEntry(false));
    $("#new-folder-btn").addEventListener("click", () => createEntry(true));
  }

  // Pull the editor's current text into the active file (before save/switch).
  function syncActiveFile() {
    if (codeEditor && project.activeFile != null &&
        Object.prototype.hasOwnProperty.call(project.files, project.activeFile)) {
      project.files[project.activeFile] = codeEditor.getValue();
    }
  }

  // Build the project state from saved work, migrating the legacy single-code format.
  function loadProjectFromSaved(saved) {
    let files = {};
    let active = null;

    if (saved.project && saved.project.files && Object.keys(saved.project.files).length) {
      files = Object.assign({}, saved.project.files);
      active = saved.project.activeFile;
    } else if (saved.code && saved.code.trim()) {
      // migrate old single-file attempts
      const ext = ({
        java: "java", python: "py", javascript: "js",
        "text/typescript": "ts", "text/x-c++src": "cpp",
        "text/x-csharp": "cs", go: "go"
      })[saved.codeLang] || "txt";
      const name = "Solution." + ext;
      files[name] = saved.code;
      active = name;
    }

    if (!active || !Object.prototype.hasOwnProperty.call(files, active)) {
      const firstFile = Object.keys(files).filter((p) => !p.endsWith("/"))[0];
      active = firstFile || null;
    }
    project = { files, activeFile: active };
    renderFileTree();
    openFile(active, true);
  }

  // Sorted paths: folders and files interleaved alphabetically, folders first within a level.
  function sortedPaths() {
    return Object.keys(project.files).sort((a, b) => a.localeCompare(b));
  }

  function renderFileTree() {
    const tree = $("#file-tree");
    if (!tree) return;
    const paths = sortedPaths();
    if (!paths.length) {
      tree.innerHTML = `<li class="empty-note">No files yet. Click <strong>＋ File</strong>
        to add one (e.g. <code>src/Main.java</code>).</li>`;
      return;
    }
    tree.innerHTML = "";
    paths.forEach((path) => {
      const isFolder = path.endsWith("/");
      const depth = path.replace(/\/$/, "").split("/").length - 1;
      const name = (path.replace(/\/$/, "").split("/").pop()) + (isFolder ? "/" : "");
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="tree-row ${isFolder ? "folder" : ""} ${path === project.activeFile ? "active" : ""}"
             data-path="${escapeHtml(path)}">
          <span class="tree-indent" style="width:${depth * 12}px"></span>
          <span class="tw-ico">${iconFor(path)}</span>
          <span class="tw-name">${escapeHtml(name)}</span>
          <span class="tw-del" title="Delete">✕</span>
        </div>`;
      tree.appendChild(li);
    });

    tree.querySelectorAll(".tree-row").forEach((row) => {
      const path = row.dataset.path;
      row.addEventListener("click", (e) => {
        if (e.target.classList.contains("tw-del")) { deleteEntry(path); return; }
        if (!path.endsWith("/")) openFile(path);
      });
    });
  }

  function openFile(path, skipSync) {
    if (!skipSync) syncActiveFile();
    const label = $("#active-file-path");
    const empty = $("#code-empty");

    if (!path || path.endsWith("/") ||
        !Object.prototype.hasOwnProperty.call(project.files, path)) {
      project.activeFile = null;
      if (codeEditor) { codeEditor.setValue(""); codeEditor.setOption("readOnly", true); }
      if (label) label.textContent = "No file open";
      if (empty) empty.style.display = "flex";
      renderFileTree();
      return;
    }

    project.activeFile = path;
    if (empty) empty.style.display = "none";
    if (codeEditor) {
      codeEditor.setOption("readOnly", false);
      codeEditor.setOption("mode", modeFor(path));
      codeEditor.setValue(project.files[path] || "");
      applyHintingFor(path);
      setTimeout(() => codeEditor.refresh(), 0);
    } else if ($("#code-area")) {
      $("#code-area").value = project.files[path] || "";
    }
    if (label) label.textContent = path;
    renderFileTree();
  }

  function createEntry(isFolder) {
    const example = isFolder ? "src/model/" : "src/Main.java";
    let input = prompt(
      isFolder ? "New folder path:" : "New file path (include extension):",
      example
    );
    if (input == null) return;
    let path = normPath(input);
    if (!path) return;

    if (isFolder) {
      if (!path.endsWith("/")) path += "/";
      if (project.files[path] != null) { toast("Folder already exists"); return; }
      project.files[path] = ""; // folder marker
      renderFileTree();
      persist(false);
      return;
    }

    if (path.endsWith("/")) { toast("A file needs a name"); return; }
    if (Object.prototype.hasOwnProperty.call(project.files, path)) {
      toast("File already exists — opening it");
      openFile(path);
      return;
    }
    project.files[path] = "";
    openFile(path);
    persist(false);
  }

  function deleteEntry(path) {
    const isFolder = path.endsWith("/");
    const label = isFolder ? "folder and everything inside it" : "file";
    if (!confirm(`Delete this ${label}?\n${path}`)) return;

    if (isFolder) {
      Object.keys(project.files).forEach((p) => {
        if (p === path || p.startsWith(path)) delete project.files[p];
      });
    } else {
      delete project.files[path];
    }
    if (project.activeFile && !Object.prototype.hasOwnProperty.call(project.files, project.activeFile)) {
      const next = Object.keys(project.files).filter((p) => !p.endsWith("/"))[0] || null;
      openFile(next, true);
    } else {
      renderFileTree();
    }
    persist(false);
  }

  // Collected files for export/eval (excludes folder markers).
  function projectFileList() {
    syncActiveFile();
    return Object.keys(project.files)
      .filter((p) => !p.endsWith("/"))
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({ path, content: project.files[path] || "" }));
  }

  /* -------------------------- Settings modal -------------------------- */
  function openSettings() {
    const s = window.LLM.getSettings();
    $("#set-mode").value = s.mode;
    $("#set-provider").value = s.provider;
    $("#set-model").value = s.model;
    $("#set-key").value = s.apiKey;
    $("#set-proxy-url").value = s.proxyUrl;
    syncSettingsFields();
    $("#settings-modal").classList.remove("hidden");
  }
  function closeSettings() { $("#settings-modal").classList.add("hidden"); }

  function syncSettingsFields() {
    const isKiro = $("#set-provider").value === "kiro";
    const proxy = $("#set-mode").value === "proxy";
    // In Kiro manual mode there's no API call, so hide key/model/proxy entirely.
    $("#byok-fields").classList.toggle("hidden", isKiro || proxy);
    $("#proxy-fields").classList.toggle("hidden", isKiro || !proxy);
    const modeField = $("#set-mode").closest(".field");
    if (modeField) modeField.classList.toggle("hidden", isKiro);
    let note = $("#kiro-note");
    if (isKiro) {
      if (!note) {
        note = document.createElement("p");
        note.id = "kiro-note";
        note.className = "warn-note";
        $("#byok-fields").parentNode.insertBefore(note, $("#byok-fields"));
      }
      note.textContent = "Kiro mode makes no API call. Clicking Evaluate copies a " +
        "prompt to paste into the Kiro IDE chat; paste Kiro's JSON reply back via " +
        "“⬇ Import result”.";
      note.classList.remove("hidden");
    } else if (note) {
      note.classList.add("hidden");
    }
  }

  function initSettings() {
    $("#eval-settings-btn").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", closeSettings);
    $("#set-mode").addEventListener("change", syncSettingsFields);
    // sensible default model when provider changes
    $("#set-provider").addEventListener("change", () => {
      const m = $("#set-model");
      const isDefault = !m.value || m.value.startsWith("gpt") ||
        m.value.startsWith("claude") || m.value.startsWith("gemini");
      if (isDefault) {
        m.value = ({
          anthropic: "claude-3-5-sonnet-latest",
          gemini: "gemini-3.8-flash",
          openai: "gpt-4o-mini"
        })[$("#set-provider").value] || "gpt-4o-mini";
      }
      syncSettingsFields();
    });
    $("#settings-save").addEventListener("click", () => {
      window.LLM.saveSettings({
        mode: $("#set-mode").value,
        provider: $("#set-provider").value,
        model: $("#set-model").value.trim(),
        apiKey: $("#set-key").value.trim(),
        proxyUrl: $("#set-proxy-url").value.trim()
      });
      closeSettings();
      toast("Settings saved");
    });
    $("#settings-modal").addEventListener("click", (e) => {
      if (e.target.id === "settings-modal") closeSettings();
    });
  }

  /* -------------------------- Evaluation -------------------------- */
  function resetEvaluation() {
    const body = $("#eval-body");
    if (!body) return;
    body.innerHTML = `<div class="eval-empty muted">
      <p>Submit your attempt and an LLM will score it against an LLD rubric
         (requirements, class design, diagrams, code quality) and suggest improvements.</p>
      <p>First time? Click <strong>⚙ LLM Settings</strong> to choose a provider — an API
         (Gemini/OpenAI/Anthropic) or <strong>Kiro (manual)</strong>, which hands you a
         prompt to paste into the IDE chat.</p>
    </div>`;
    $("#eval-status").textContent = "";
    if ($("#eval-import")) {
      $("#eval-import").classList.add("hidden");
      $("#eval-import-text").value = "";
    }
  }

  function buildEvalPayload() {
    const problem = getProblem(currentProblemId);
    const w = collectWork();
    const r = w.requirements;
    return {
      problemTitle: problem.title,
      difficulty: problem.difficulty,
      problemBrief: problem.brief,
      requirements: {
        actors: r["req-actors"],
        functional: r["req-functional"],
        nonfunctional: r["req-nonfunctional"],
        entities: r["req-entities"],
        apis: r["req-apis"],
        assumptions: r["req-assumptions"]
      },
      diagrams: {
        class: w.diagrams.class, sequence: w.diagrams.sequence,
        state: w.diagrams.state, er: w.diagrams.er
      },
      files: projectFileList()
    };
  }

  function hasAnyContent(payload) {
    const r = payload.requirements;
    const anyReq = Object.values(r).some((v) => v && v.trim());
    const anyDiag = Object.values(payload.diagrams).some((v) => v && v.trim());
    const anyCode = (payload.files || []).some((f) => f.content && f.content.trim());
    return anyReq || anyDiag || anyCode;
  }

  async function runEvaluation() {
    const body = $("#eval-body");
    const status = $("#eval-status");

    if (!window.LLM.isConfigured()) {
      openSettings();
      toast("Add your LLM settings first");
      return;
    }
    const payload = buildEvalPayload();
    if (!hasAnyContent(payload)) {
      toast("Write some requirements, a diagram, or code first");
      return;
    }

    persist(true);

    // Kiro manual mode: no API call — hand off a prompt to paste into the IDE chat.
    if (window.LLM.getSettings().provider === "kiro") {
      handleKiroEvaluation(payload);
      return;
    }

    body.innerHTML = `<div class="eval-loading"><span class="spinner"></span>
      Evaluating your solution with the LLM…</div>`;
    status.textContent = "";
    $("#evaluate-btn").disabled = true;

    try {
      const result = await window.LLM.evaluate(payload);
      renderEvaluation(result);
      status.textContent = "Evaluated " + new Date().toLocaleTimeString();
    } catch (err) {
      body.innerHTML = `<div class="diagram-error">⚠ Evaluation failed:\n${escapeHtml(String(err.message || err))}</div>
        <p class="muted">Check your provider/model/key in ⚙ LLM Settings. CORS or network
        errors usually mean you should use the local proxy mode (see README).</p>`;
    } finally {
      $("#evaluate-btn").disabled = false;
    }
  }

  /* ---- Kiro manual mode: build prompt, copy/download, show steps ---- */
  let lastKiroPrompt = "";

  function handleKiroEvaluation(payload) {
    const body = $("#eval-body");
    const prompt = window.LLM.buildPrompt(payload);
    lastKiroPrompt = prompt;

    copyToClipboard(prompt).then((ok) => {
      $("#eval-status").textContent = ok
        ? "Prompt copied " + new Date().toLocaleTimeString()
        : "";
    });

    body.innerHTML = `
      <div class="kiro-steps">
        <h3>Evaluate with Kiro</h3>
        <p>No API call is made in this mode. Follow these steps:</p>
        <ol>
          <li>The evaluation prompt was <strong class="copy-ok" id="kiro-copy-state">copied to your clipboard</strong>.
              (If not, use the buttons below.)</li>
          <li>Open the <strong>Kiro IDE chat</strong> and paste it (Ctrl/Cmd+V), then send.</li>
          <li>Kiro replies with a JSON block. Copy that JSON.</li>
          <li>Click <strong>⬇ Import result</strong> above, paste the JSON, and
              <strong>Render result</strong> — it shows below just like an API score.</li>
        </ol>
        <div class="eval-import-actions">
          <button class="btn btn-small active" id="kiro-copy">⧉ Copy prompt again</button>
          <button class="btn btn-small" id="kiro-download">⇩ Download prompt (.md)</button>
          <button class="btn btn-small" id="kiro-open-import">⬇ Open import box</button>
        </div>
        <details style="margin-top:12px">
          <summary class="muted">Preview the prompt</summary>
          <div class="eval-raw" id="kiro-prompt-preview">${escapeHtml(prompt)}</div>
        </details>
      </div>`;
    $("#evaluate-btn").disabled = false;

    $("#kiro-copy").addEventListener("click", async () => {
      const ok = await copyToClipboard(lastKiroPrompt);
      toast(ok ? "Prompt copied" : "Copy failed — select the preview text");
    });
    $("#kiro-download").addEventListener("click", () => {
      const problem = getProblem(currentProblemId);
      downloadText(`kiro-eval-prompt-${problem.id}.md`, lastKiroPrompt);
    });
    $("#kiro-open-import").addEventListener("click", () => showImportBox(true));
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to legacy */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  /* ---- Import-result box ---- */
  function showImportBox(show) {
    $("#eval-import").classList.toggle("hidden", !show);
    if (show) { $("#eval-import-text").focus(); }
  }

  function renderImportedResult() {
    const text = $("#eval-import-text").value;
    if (!text.trim()) { toast("Paste the result JSON first"); return; }
    let result;
    try {
      result = window.LLM.parse(text);
    } catch (err) {
      toast("Couldn't parse that JSON");
      $("#eval-body").innerHTML =
        `<div class="diagram-error">⚠ ${escapeHtml(String(err.message || err))}</div>`;
      return;
    }
    renderEvaluation(result);
    $("#eval-status").textContent = "Imported " + new Date().toLocaleTimeString();
    showImportBox(false);
  }

  function renderEvaluation(res) {
    const body = $("#eval-body");
    const overall = Math.max(0, Math.min(100, Math.round(res.overall || 0)));
    const rubric = window.LLM.RUBRIC;

    const rows = rubric.map((dim) => {
      const sc = res.scores[dim.key] || {};
      const val = Math.max(0, Math.min(10, Number(sc.score) || 0));
      return `<div class="rubric-row">
        <div class="rubric-head"><span>${escapeHtml(dim.label)}</span>
          <span class="score-num">${val}/10</span></div>
        <div class="bar"><i style="width:${val * 10}%"></i></div>
        ${sc.comment ? `<div class="rubric-comment">${escapeHtml(sc.comment)}</div>` : ""}
      </div>`;
    }).join("");

    const strengths = (res.strengths || [])
      .map((s) => `<li class="good">${escapeHtml(s)}</li>`).join("");
    const improvements = (res.improvements || [])
      .map((s) => `<li class="improve">${escapeHtml(s)}</li>`).join("");

    body.innerHTML = `
      <div class="eval-overall">
        <div class="score-ring" style="--pct:${overall}%"><span>${overall}</span></div>
        <div class="verdict">
          <h3>Overall score: ${overall}/100</h3>
          <p class="muted">${escapeHtml(res.verdict || "")}</p>
        </div>
      </div>
      <div class="rubric">${rows}</div>
      ${strengths ? `<div class="eval-section"><h3>Strengths</h3><ul>${strengths}</ul></div>` : ""}
      ${improvements ? `<div class="eval-section"><h3>Suggestions to improve</h3><ul>${improvements}</ul></div>` : ""}
    `;
  }

  function initEvaluation() {
    $("#evaluate-btn").addEventListener("click", runEvaluation);
    $("#eval-import-btn").addEventListener("click", () =>
      showImportBox($("#eval-import").classList.contains("hidden")));
    $("#eval-import-render").addEventListener("click", renderImportedResult);
    $("#eval-import-cancel").addEventListener("click", () => showImportBox(false));
  }

  /* -------------------------- Boot -------------------------- */
  function initMermaid() {
    if (!window.mermaid) {
      console.error("Mermaid failed to load from CDN.");
      return;
    }
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "loose",
      flowchart: { htmlLabels: true }
    });
    mermaidReady = true;
  }

  function boot() {
    initMermaid();
    populateProblemSelect();
    initTabs();
    buildDiagramEditors();
    initRequirementListeners();
    initSolutionToggle();
    initHeaderButtons();
    initCodeEditor();
    initSettings();
    initEvaluation();

    // save on tab close
    window.addEventListener("beforeunload", () => persist(true));

    const last = safeStore.get(STORAGE_PREFIX + "last");
    const startId = (last && getProblem(last)) ? last : window.PROBLEMS[0].id;
    $("#problem-select").value = startId;
    loadProblem(startId);           // paints from local cache immediately

    // Detect the save server; if present, re-load so the durable disk copy wins.
    probeServer().then(() => {
      if (SERVER.available && currentProblemId) loadProblem(currentProblemId);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
