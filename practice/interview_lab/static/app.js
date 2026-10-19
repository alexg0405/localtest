"use strict";

const $ = id => document.getElementById(id);
let current = null;        // interview id
let interviews = [];       // lobby list
let latest = null;         // last /api/state payload
let tickBase = null;       // {elapsed, at}: a smooth local clock between polls
let inLobby = true;
let changeSeen = false;    // the candidate has opened the Change tab since it was revealed
let activeNote = "plan";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MIC_KEY = MAC ? "⌥M" : "Alt+M";   // the mic shortcut, as each keyboard labels it

const NOTES = {
  plan: { hint: "<b>5–15 min.</b> What you found, which files matter, how the call path works, and what you'll change first.", placeholder: "## What I found\n- \n\n## Files I'll touch\n- \n\n## Plan\n1. " },
  assumptions: { hint: "<b>Any time.</b> One assumption per line, especially anything the interviewer didn't answer.", placeholder: "- I'm assuming…" },
  patch_review: { hint: "<b>40–50 min.</b> Review <code>patch_review/ai_patch.diff</code> like a pull request: what's right, what's wrong, and the test that proves it.", placeholder: "## Verdict\nApprove / Request changes\n\n## What it gets right\n- \n\n## Problems\n- \n\n## Test I'd add\n- " },
  explanation: { hint: "<b>50–60 min.</b> What you changed and why, the tradeoffs, how you verified it, and what's left.", placeholder: "## What I changed\n- \n\n## Why / tradeoffs\n- \n\n## How I verified it\n- \n\n## What's left\n- " },
  transcript: { hint: "<b>Optional.</b> Paste your Claude Code conversation (<code>/export</code> copies it) so your prompts and checks can be scored.", placeholder: "> your message to Claude Code\n⏺ Claude's reply\n…" },
};
const SUGGESTED = [
  "What should happen when the input is invalid?",
  "Can I change public function signatures?",
  "Is concurrency or persistence in scope?",
];
const DOMAINS = { "commerce-orders": ["commerce", "Commerce"], "banking-ledger": ["banking", "Banking"], "unfamiliar-repo": ["repo", "Unfamiliar repo"], "amazon-final-1": ["amazon", "Amazon final · Round 1"], "amazon-final-2": ["amazon", "Amazon final · Round 2"], "amazon-behavioral": ["amazon", "Amazon · Behavioral"] };
const AMAZON_NOTES = {
  plan: { hint: "<b>Before you code.</b> Your approach: data structures, time and space complexity, and the edge cases you'll handle. Say it out loud too.", placeholder: "## Approach\n- \n\n## Complexity\n- Time: \n- Space: \n\n## Edge cases\n- " },
  assumptions: { hint: "<b>Any time.</b> What you assumed when the interviewer didn't specify.", placeholder: "- I'm assuming…" },
  explanation: { hint: "<b>40–45 min.</b> Dry-run your code on the example by hand: the state after each step, then the answer.", placeholder: "## Dry run on the example\n1. \n\n## Complexity\n- " },
};
const notesFor = () => (latest && latest.interview.format === "amazon-final" ? { ...NOTES, ...AMAZON_NOTES } : NOTES);

function remember(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3400);
}

async function call(path, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interview: current, ...body }) };
  // Relative, so the dashboard works both on its own port and under Roomside at /practice/.
  const response = await fetch(path.replace(/^\//, ""), options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// Minimal Markdown: headings, lists, code fences, paragraphs, inline code, bold, italics.
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}
function markdown(source) {
  const lines = source.replace(/\r/g, "").split("\n");
  let html = "", list = null, item = null, paragraph = [], code = null;
  const flush = () => { if (paragraph.length) { html += `<p>${inline(paragraph.join(" "))}</p>`; paragraph = []; } };
  const endItem = () => { if (item !== null) { html += `<li>${inline(item)}</li>`; item = null; } };  // whole item at once, so **bold** can wrap lines
  const closeList = () => { endItem(); if (list) { html += `</${list}>`; list = null; } };
  let table = null;
  const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
  const closeTable = () => {
    if (!table) return;
    const [head, ...body] = table.filter(row => !/^\s*\|?\s*:?-{2,}/.test(row));
    html += `<table class="md-table"><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map(row => `<tr>${cells(row).map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    table = null;
  };
  for (const line of lines) {
    if (code === null && /^\s*\|/.test(line)) { flush(); closeList(); (table = table || []).push(line); continue; }
    closeTable();
    if (code !== null) {
      if (line.startsWith("```")) { html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`; code = null; } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) { flush(); closeList(); code = []; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (heading) { flush(); closeList(); const level = Math.min(heading[1].length, 3); html += `<h${level}>${inline(heading[2])}</h${level}>`; }
    else if (bullet || numbered) {
      flush(); endItem();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
      item = (bullet || numbered)[1];
    } else if (!line.trim()) { flush(); closeList(); }
    else if (item !== null && /^\s{2,}\S/.test(line)) { item += " " + line.trim(); }
    else { closeList(); paragraph.push(line.trim()); }
  }
  if (code !== null) html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
  closeTable(); flush(); closeList();
  return html;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Lobby

async function loadInterviews() {
  interviews = await call("/api/interviews");
  const saved = recall("lab.interview");
  if (!current) current = interviews.some(i => i.id === saved) ? saved : interviews[0].id;
  $("interview").innerHTML = interviews.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.title)}</option>`).join("");
  $("interview").value = current;
  renderCards();
}

let lobbyMode = recall("lab.mode") === "coach" ? "coach" : "real";
const MODE_HELP = {
  real: "Real interviewer: answers clarifications only, hints cost points, and nothing is explained until you submit.",
  coach: "Coach: a friendly tutor. Ask for hints any time, get help reading failing tests, ask about concepts, and see the approach when you want it.",
};

function renderModeToggles() {
  const mode = latest && latest.session.started && latest.interview.format === "problem" && !inLobby ? latest.session.state.mode || "real" : lobbyMode;
  document.querySelectorAll(".mode-toggle button").forEach(button => {
    const group = button.closest(".mode-toggle");
    const value = group.id === "ide-mode" ? (latest && latest.session.started ? latest.session.state.mode || "real" : lobbyMode) : lobbyMode;
    button.setAttribute("aria-checked", String(button.dataset.mode === value));
  });
  $("mode-help").textContent = MODE_HELP[lobbyMode];
  document.body.classList.toggle("coach-mode", mode === "coach" && !!latest && latest.interview.format === "problem");
}

function renderProblemTiles() {
  $("problem-cards").innerHTML = interviews.filter(i => i.format === "problem").map(i => {
    const score = i.last_score;
    const status = i.status === "running" || i.status === "paused" ? `<span class="mid">● In progress</span>${i.mode === "coach" ? " · coach" : ""}`
      : score !== null && score !== undefined ? `<span class="${score === 100 ? "done" : score >= 60 ? "mid" : "low"}">${score === 100 ? "✓" : "●"} Last: <b>${score}%</b></span>${i.last_mode === "coach" ? " · coach" : " · real"}`
      : "Not tried yet";
    return `<button class="ptile${i.id === current ? " selected" : ""}" role="listitem" data-id="${escapeHtml(i.id)}">
      <div class="ptile-top"><span class="pnum">#${i.number}</span><span class="diff ${escapeHtml(i.difficulty)}">${escapeHtml(i.difficulty)}</span></div>
      <h3>${escapeHtml(i.title.replace(/^\d+\.\s*/, ""))}</h3>
      <div class="ptags">${escapeHtml((i.tags || []).join(" · "))}</div>
      <div class="pstatus">${status}</div>
    </button>`;
  }).join("");
  document.querySelectorAll(".ptile").forEach(tile => tile.onclick = () => { select(tile.dataset.id); document.querySelector(".launch").scrollIntoView({ behavior: "smooth", block: "center" }); });
}

function renderCards() {
  renderProblemTiles();
  renderModeToggles();
  $("lobby-cards").innerHTML = interviews.filter(i => i.format !== "problem").map(i => {
    const [cls, label] = DOMAINS[i.id] || ["repo", "Interview"];
    const status = i.status === "running" || i.status === "paused" ? `<span class="status running">${i.status === "paused" ? "Paused" : "In progress"}</span>` : i.status === "submitted" ? `<span class="status submitted">Submitted</span>` : "";
    return `<button class="card${i.id === current ? " selected" : ""}" role="listitem" data-id="${escapeHtml(i.id)}">
      <div class="card-top"><span class="domain ${cls}"><i></i>${label}</span>${status}</div>
      <h3>${escapeHtml(i.title)}</h3>
      <p>${escapeHtml(i.summary)}</p>
      <div class="card-meta">${(i.tags || ["python", "pytest", `${i.duration_minutes} min`, "AI-assisted"]).map(t => `<span class="tag${t === "no AI" ? " tag-warn" : ""}">${escapeHtml(t)}</span>`).join("")}</div>
    </button>`;
  }).join("");
  document.querySelectorAll(".card").forEach(card => card.onclick = () => select(card.dataset.id));
}

function select(id) {
  if (id === current) return;
  current = id;
  remember("lab.interview", id);
  changeSeen = false;
  $("interview").value = id;
  renderCards();
  refresh();
}

function showView() {
  const started = latest && latest.session.started;
  const reportOpen = !$("report").hidden;
  $("intro").hidden = reportOpen || (started && !inLobby);
  $("session").hidden = reportOpen || !started || inLobby;
  const view = reportOpen ? "report" : $("session").hidden ? "lobby" : "ide";
  if (view !== showView.last) {
    window.scrollTo(0, 0);
    showView.last = view;
    if (view === "ide" && code.cm) setTimeout(() => code.cm.refresh(), 0);  // CodeMirror can't measure itself while hidden
    if (view === "ide") setTimeout(scrollPop, 0);   // open on the latest reply
    else hush();
  }
  document.body.classList.toggle("locked-scroll", view !== "lobby");
}

// Interview view

function renderApi(apiInfo) {
  const badge = $("api-badge");
  badge.textContent = apiInfo.ready ? `Interviewer · API · ${apiInfo.model}` : apiInfo.enabled ? "Interviewer · API key missing" : "Interviewer · offline";
  badge.title = apiInfo.message + (apiInfo.usage && apiInfo.usage.requests ? ` This session: ${apiInfo.usage.requests} request(s), ${apiInfo.usage.input_tokens} input / ${apiInfo.usage.output_tokens} output tokens (cap ${apiInfo.max_requests_per_session} requests, ${apiInfo.max_output_tokens} output tokens each).` : "");
  badge.classList.toggle("api-on", apiInfo.enabled);
  $("use-api-wrap").hidden = !apiInfo.ready;
  $("api-feedback").hidden = !apiInfo.ready;
}

function renderPhases(session) {
  const total = session.duration / 60;
  $("phases").innerHTML = session.phases.map((p, i) => `<span class="${i < session.phase ? "done" : ""}" style="width:${((p.end - p.start) / total) * 100}%" title="${p.start}–${p.end} min · ${escapeHtml(p.name)}"></span>`).join("");
  $("change-tick").hidden = session.change_at === null;
  if (session.change_at !== null) $("change-tick").style.left = `calc(${(session.change_at / session.duration) * 100}% - 1px)`;
  const phase = session.phases[Math.min(session.phase, session.phases.length - 1)];
  $("phase-pill").innerHTML = session.state.status === "submitted" ? "Submitted" : session.phase >= session.phases.length ? "<b>Overtime</b> · wrap up and submit" : `<b>Phase ${session.phase + 1}/${session.phases.length}</b> · ${escapeHtml(phase.name)}`;
}

function renderTimer() {
  if (!latest || !latest.session.started) return;
  const session = latest.session;
  const status = session.state.status;
  let elapsed = session.elapsed;
  if (status === "running" && tickBase) elapsed = tickBase.elapsed + (Date.now() - tickBase.at) / 1000;
  $("elapsed").textContent = clock(elapsed);
  $("bar-fill").style.width = `${Math.min(100, (elapsed / session.duration) * 100)}%`;
  const remaining = session.duration - elapsed;
  const timer = $("timer");
  timer.classList.toggle("paused", status === "paused");
  timer.classList.toggle("warn", status === "running" && remaining > 0 && remaining <= 300);
  timer.classList.toggle("over", status !== "submitted" && remaining <= 0);
  $("timer-status").textContent = status === "paused" ? "⏸ paused" : status === "submitted" ? "✓ submitted · you can keep working and resubmit" : remaining > 0 ? `${clock(remaining)} left` : "time is up · submit when ready";
  if (status === "running" && session.change_at !== null && session.state.change_revealed_at === null && elapsed >= session.change_at && !renderTimer.asked) {
    renderTimer.asked = true;
    refresh().finally(() => { renderTimer.asked = false; });
  }
}

function renderFlow(info) {
  const items = info.phases.map(p => `<li><b>${p.start}–${p.end}</b><span>${escapeHtml(p.name)}</span></li>`);
  const at = info.change_at_minutes;
  if (at !== null) {
    const index = info.phases.findIndex(p => p.start <= at && at < p.end);
    items.splice(index + 1, 0, `<li class="flow-change"><b>${at}:00</b><span>${info.format === "amazon-final" ? "Interviewer's follow-up" : "Requirement change"}</span></li>`);
  }
  document.querySelector(".flow").innerHTML = items.join("");
  document.querySelector(".flow").style.setProperty("--flow-cols", items.length);
}

let formatFor = null;
function applyFormat(info) {
  if (formatFor === info.id) return;
  formatFor = info.id;
  const amazon = info.format === "amazon-final";
  document.querySelector("#timer .of").textContent = `/ ${info.duration_minutes}:00`;
  $("run-tests").hidden = !info.run_tests_allowed;
  document.querySelector('[data-copy="cmd-assistant"]').parentElement.hidden = !info.ai_allowed;
  document.querySelector("#change-tab").childNodes[1].textContent = amazon ? "Follow-up" : "Change";
  document.querySelector("#change-locked h3").textContent = `Unlocks at ${info.change_at_minutes}:00`;
  document.querySelector("#change-locked p").textContent = amazon ? "Partway through the coding problem, the interviewer adds a follow-up, as Amazon interviewers usually do. Keep going." : "Halfway through, the interviewer changes a requirement, just like in a real loop. Keep building.";
  document.querySelector(".change-banner").lastChild.textContent = amazon ? "Follow-up from the interviewer" : "Requirement change from the interviewer";
  const behavioralOnly = info.format === "amazon-behavioral";
  $("change-tab").hidden = info.change_at_minutes === null;
  $("console").hidden = behavioralOnly;
  $("custom-tab").hidden = !(info.editor_files || []).length;
  $("custom-code").value = info.custom_input || "";
  document.querySelectorAll(".code-tab").forEach(tab => tab.remove());
  const firstNote = document.querySelector("[data-note-tab]");
  (info.editor_files || []).forEach(path => {
    const tab = document.createElement("button");
    tab.className = "tab file code-tab";
    tab.dataset.codeTab = path;
    tab.title = path;
    tab.innerHTML = `<span class="lang">PY</span>${escapeHtml(path.split("/").pop())}<i class="dot"></i>`;
    tab.onclick = () => openCode(path);
    firstNote.parentElement.insertBefore(tab, firstNote);
  });
  code.path = null;
  const labels = info.note_tabs;
  document.querySelectorAll("[data-note-tab]").forEach(tab => {
    const key = tab.dataset.noteTab;
    tab.hidden = !!labels && !(key in labels);
    tab.firstChild.textContent = labels && labels[key] ? labels[key] : { plan: "plan.md", assumptions: "assumptions.md", patch_review: "patch_review.md", explanation: "explanation.md", transcript: "transcript.txt" }[key];
  });
  if (labels && !(activeNote in labels)) showNote(Object.keys(labels)[0]); else showNote(activeNote);
  if (!info.run_tests_allowed) {
    $("test-result").className = "test-empty";
    $("test-result").innerHTML = "This round simulates Amazon's interview editor, which doesn't run code. Reason about correctness and <b>dry-run your code by hand</b> on the example. Grading runs your code after you submit.";
  }
  $("question").placeholder = amazon || behavioralOnly ? "Answer the interviewer, or ask a question…" : "Ask the interviewer a clarifying question…";
  if (behavioralOnly) showTab("interviewer");
}

function chatItems(questions, spoken = []) {
  // Questions and replies, think-aloud, and behavioral answers, in the order they happened.
  const answers = ((latest && latest.session.state.behavioral) || { answers: [] }).answers.flatMap(a => a.parts.map(p => ({ at: p.at, answer: p.text })));
  return questions.map(q => ({ at: q.at, q })).concat(spoken.map(s => ({ at: s.at, said: s.text })), answers).sort((a, b) => a.at - b.at);
}

function renderQuestions(questions, spoken = []) {
  const asked = questions.filter(q => q.source !== "interviewer");
  $("q-count").hidden = !asked.length;
  $("q-count").textContent = asked.length;
  if (!questions.length && !spoken.length && !(latest && latest.session.state.behavioral)) {
    const coach = latest && latest.session.state.mode === "coach" && latest.interview.format === "problem";
    const problem = latest && latest.interview.format === "problem";
    const ideas = coach ? ["Can I get a hint?", "How should I start a problem like this?", "What edge cases should I think about?"] : problem ? ["How large can the input be?", "Can the input be empty?", "Can there be duplicates?"] : SUGGESTED;
    const intro = coach ? "Your coach is here to help you learn. Think out loud, ask about concepts (\"what's a heap?\"), or ask for a hint whenever you're stuck." : "Press the mic and talk, or type. The interviewer answers clarifying questions about requirements. Strong candidates ask a few in the first five minutes.";
    $("questions").innerHTML = `<div class="chat-empty"><h3>${coach ? "Let's work through it together" : "Ask before you build"}</h3><p>${intro}</p><div class="suggest">${ideas.map(s => `<button type="button">${escapeHtml(s)}</button>`).join("")}</div></div>`;
    document.querySelectorAll(".suggest button").forEach(b => b.onclick = () => { $("question").value = b.textContent; $("question").focus(); });
    return;
  }
  const items = chatItems(questions, spoken);
  const you = (text, at, extra = "", label = "") => `<div class="msg you ${extra}"><div class="avatar">You</div><div><div class="bubble">${escapeHtml(text)}</div><div class="meta">${label}${clock(at)}</div></div></div>`;
  const them = (text, meta, extra = "") => `<div class="msg them ${extra}"><div class="avatar">IV</div><div><div class="bubble">${escapeHtml(text)}</div><div class="meta">${meta}</div></div></div>`;
  $("questions").innerHTML = items.map(({ at, q, said, answer }) => {
    if (answer) return you(answer, at, "", "answer · ");
    if (said) return you(said, at, "said", "said aloud · ");
    if (q.source === "coach-ai") return you(q.question, at, "", q.voice ? "🎙 " : "") + them(q.answer, q.mode === "real" ? "Interviewer · Claude" : "Coach · Claude", q.mode === "real" ? "" : "coach");
    if (q.source === "interviewer") {
      const kind = (q.kind || "").startsWith("hint") || q.kind === "coach-ai:hint" ? "hint" : (q.kind || "").startsWith("coach") || q.kind === "approach" ? "coach" : "cue";
      const label = kind === "hint" ? "Hint" : q.kind === "approach" ? "Approach" : latest && latest.session.state.mode === "coach" && latest.interview.format === "problem" ? "Coach" : "Interviewer";
      return q.kind === "approach" ? `<div class="msg them coach"><div class="avatar">IV</div><div><div class="bubble md">${markdown(q.answer)}</div><div class="meta">${label} · ${clock(at)}</div></div></div>` : them(q.answer, `${label} · ${clock(at)}`, kind);
    }
    return you(q.question, at, "", q.voice ? "🎙 " : "") + them(q.answer, `${q.source === "api" ? "API interviewer" : latest && latest.session.state.mode === "coach" && latest.interview.format === "problem" ? "Coach" : "Interviewer"}${q.topic ? " · " + escapeHtml(q.topic) : ""}`);
  }).join("");
  $("questions").scrollTop = $("questions").scrollHeight;
}

function renderNotes(notes, force) {
  document.querySelectorAll("[data-note]").forEach(area => {
    if (force || document.activeElement !== area) area.value = notes[area.dataset.note] || "";
  });
  document.querySelectorAll("[data-note-tab]").forEach(tab => tab.classList.toggle("filled", !!(notes[tab.dataset.noteTab] || "").trim()));
  updateGutter();
}

function updateGutter() {
  const area = document.querySelector(`[data-note="${activeNote}"]`);
  const count = Math.max(1, area.value.split("\n").length);
  $("gutter").textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
  $("gutter").scrollTop = area.scrollTop;
  $("status-lines").textContent = `Ln ${count} · ${area.value.trim() ? area.value.trim().split(/\s+/).length : 0} words`;
}

function showNote(name) {
  activeNote = name;
  $("code-area").hidden = true;
  $("note-area").hidden = false;
  document.querySelectorAll(".code-tab").forEach(tab => tab.classList.remove("active"));
  document.querySelectorAll("[data-note-tab]").forEach(tab => tab.classList.toggle("active", tab.dataset.noteTab === name));
  document.querySelectorAll("[data-note]").forEach(area => { area.hidden = area.dataset.note !== name; });
  const area = document.querySelector(`[data-note="${name}"]`);
  area.placeholder = notesFor()[name].placeholder;
  $("editor-hint").innerHTML = notesFor()[name].hint;
  $("status-note").textContent = name === "transcript" ? "Plain text" : "Markdown";
  updateGutter();
}

// The code editor: edits the workspace file directly, so it stays in sync with VS Code or any other editor.
const code = { path: null, mtime: null, dirty: false, cm: null, timer: null, loading: false };

function codeValue() { return code.cm ? code.cm.getValue() : $("code-fallback").value; }
function setCodeValue(text) {
  code.loading = true;
  if (code.cm) { code.cm.setValue(text); code.cm.clearHistory(); setTimeout(() => code.cm.refresh(), 0); } else $("code-fallback").value = text;
  code.loading = false;
}

function ensureCodeMirror() {
  if (code.cm || !window.CodeMirror) return;
  code.cm = CodeMirror.fromTextArea($("code-fallback"), {
    mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false, matchBrackets: true, autoCloseBrackets: true,
    extraKeys: {
      Tab: cm => (cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("    ", "end")),
      "Shift-Tab": cm => cm.indentSelection("subtract"),
      "Cmd-Enter": () => $("run-tests").click(), "Ctrl-Enter": () => $("run-tests").click(),
      "Cmd-S": () => saveCode(), "Ctrl-S": () => saveCode(),
      "Alt-M": () => { if (voice.on) stopVoice(); else startVoice(); },
    },
  });
  code.cm.on("change", () => codeChanged());
  code.cm.on("cursorActivity", () => { const pos = code.cm.getCursor(); $("status-lines").textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`; });
}

function markCodeTab() {
  document.querySelectorAll(".code-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.codeTab === code.path && !$("code-area").hidden);
    tab.classList.toggle("dirty", tab.dataset.codeTab === code.path && code.dirty);
  });
}

async function openCode(path) {
  $("note-area").hidden = true;
  $("code-area").hidden = false;
  document.querySelectorAll("[data-note-tab]").forEach(tab => tab.classList.remove("active"));
  ensureCodeMirror();
  $("editor-hint").innerHTML = `<b>${escapeHtml(path)}</b> · saved to your workspace as you type · <b>⌘/Ctrl+Enter</b> runs the tests`;
  $("status-note").textContent = "Python";
  if (code.path !== path) {
    if (code.dirty) await saveCode();
    try {
      const file = await call(`/api/file?interview=${encodeURIComponent(current)}&path=${encodeURIComponent(path)}`);
      code.path = path; code.mtime = file.mtime; code.dirty = false;
      setCodeValue(file.content);
    } catch (e) { toast(e.message); }
  }
  markCodeTab();
  setTimeout(() => { if (code.cm) { code.cm.refresh(); code.cm.focus(); } }, 0);
}

function codeChanged() {
  if (code.loading || !code.path) return;
  active();
  code.dirty = true;
  markCodeTab();
  $("saved").textContent = "Saving…";
  clearTimeout(code.timer);
  code.timer = setTimeout(saveCode, 700);
}

async function saveCode(force = false) {
  clearTimeout(code.timer);
  if (!code.path || !code.dirty) return true;
  try {
    const result = await call("/api/file", { path: code.path, content: codeValue(), mtime: force ? null : code.mtime });
    code.mtime = result.mtime; code.dirty = false;
    $("saved").textContent = "✓ Saved";
    markCodeTab();
    return true;
  } catch (e) {
    if (/changed on disk/.test(e.message)) {
      if (confirm("This file changed in your other editor.\n\nOK = keep the version in this browser and overwrite it.\nCancel = load the other version.")) return saveCode(true);
      code.path = null; await openCode(Object.keys(latest.files || {})[0]); return false;
    }
    $("saved").textContent = "Not saved: " + e.message;
    return false;
  }
}

async function syncCode(files) {
  // Pick up edits made in VS Code (or anywhere else) when there are no unsaved edits here.
  if (!code.path || code.dirty || !files || files[code.path] === undefined || files[code.path] === code.mtime) return;
  try {
    const file = await call(`/api/file?interview=${encodeURIComponent(current)}&path=${encodeURIComponent(code.path)}`);
    if (!code.dirty) { code.mtime = file.mtime; setCodeValue(file.content); toast("Loaded the latest version of the file from disk."); }
  } catch (e) { /* try again on the next refresh */ }
}

// The interviewer chat window: the whole conversation, with the reply streaming in at the bottom.
// Drag it by its title bar, resize it from any edge or corner, minimize or close it; it remembers all of that.
const pop = { streaming: false, seen: null, lastReply: "" };
const aiOn = () => problemNow() && !!latest.coach_ai && latest.coach_ai.available;   // Claude, in either role
const coachAiOn = () => aiOn() && latest.session.state.mode === "coach";
const coachNow = () => !!latest && latest.session.state.mode === "coach" && latest.interview.format === "problem";
const POP_MIN = { w: 280, h: 160 };
const popDocked = () => matchMedia("(max-width: 700px)").matches;   // on a phone-sized window it sits at the bottom

function popLayout() {
  let saved = {};
  try { saved = JSON.parse(recall("lab.pop") || "{}") || {}; } catch (e) { /* use the defaults */ }
  return { open: true, collapsed: false, x: null, y: 66, w: 380, h: 380, ...saved };
}
function savePop(changes) {
  for (const key of ["x", "y", "w", "h"]) if (typeof changes[key] === "number") changes[key] = Math.round(changes[key]);
  remember("lab.pop", JSON.stringify({ ...popLayout(), ...changes }));
}

function placePop(layout = popLayout()) {
  // Keep it on screen, even after the browser window shrinks; the saved spot comes back when it grows again.
  const box = $("coach-pop");
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.max(POP_MIN.w, Math.min(layout.w, vw - 16));
  const h = Math.max(POP_MIN.h, Math.min(layout.h, vh - 16));
  const x = Math.max(8, Math.min(layout.x === null ? vw - w - 16 : layout.x, vw - w - 8));
  const y = Math.max(8, Math.min(layout.y, vh - (layout.collapsed ? 46 : h) - 8));
  Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

const popOpen = () => !$("coach-pop").hidden;
const popShowing = () => popOpen() && !$("coach-pop").classList.contains("collapsed");

function applyPop() {
  const layout = popLayout();
  const box = $("coach-pop");
  box.hidden = !layout.open;
  box.classList.toggle("collapsed", !!layout.collapsed);
  placePop(layout);
  $("pop-min").textContent = layout.collapsed ? "+" : "–";
  $("pop-min").title = layout.collapsed ? "Expand" : "Minimize";
  $("pop-min").setAttribute("aria-label", $("pop-min").title);
  $("pop-toggle").classList.toggle("active", layout.open && !layout.collapsed);
  $("pop-toggle").title = layout.open && !layout.collapsed ? "Hide the interviewer chat" : "Show the interviewer chat";
  if (popShowing()) { $("pop-unread").hidden = true; scrollPop(); }
  popHeader();
}

function setPop(changes) { savePop(changes); applyPop(); }

function popHeader(state) {
  $("pop-who").textContent = coachNow() ? "Coach" : "Interviewer";
  if (state === undefined) {
    if ($("coach-pop").classList.contains("collapsed") && pop.lastReply) state = pop.lastReply;   // minimized, the title bar shows the latest reply
    else state = aiOn() ? "Claude · your subscription" : problemNow() ? "scripted" : "";
  }
  $("pop-state").textContent = state;
  $("pop-state").title = state;
}

function scrollPop() { const body = $("pop-body"); body.scrollTop = body.scrollHeight; }

function popLine(cls, text, label, title) {
  return `<div class="pop-line ${cls}"${title ? ` title="${title}"` : ""}>${label ? `<small>${escapeHtml(label)}</small>` : ""}${escapeHtml(text)}</div>`;
}

function renderPop(questions, spoken) {
  const body = $("pop-body");
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const who = coachNow() ? "Coach" : "Interviewer";
  const items = chatItems(questions, spoken).slice(-80);
  $("pop-log").innerHTML = items.length ? items.map(({ q, said, answer }) => {
    if (answer) return popLine("you", answer, "Your answer");
    if (said) return popLine("said", said, "", "Said aloud");
    if (q.source === "interviewer") {
      const hint = (q.kind || "").includes("hint");
      if (q.kind === "approach") return `<button type="button" class="pop-line them pop-link" data-open-tab="interviewer"><small>Approach</small>The full approach is in the Interviewer tab. Open it</button>`;
      return popLine(hint ? "them hint" : "them", q.answer, hint ? "Hint" : who);
    }
    return popLine("you", q.question, q.voice ? "🎙 You" : "") + popLine("them", q.answer, q.source === "api" ? "API interviewer" : who);
  }).join("") : `<p class="pop-empty">${coachNow() ? "Your coach's replies show up here. Ask anything, or ask for a hint." : "The interviewer's replies show up here. Type below or turn on the mic."}</p>`;
  const replies = questions.filter(q => q.answer && q.kind !== "approach");
  pop.lastReply = replies.length ? replies[replies.length - 1].answer : "";
  if (atBottom) scrollPop();
}

function popNewMessages(session) {
  const questions = session.state.questions;
  renderPop(questions, session.state.spoken || []);
  $("pop-input").placeholder = coachNow() ? "Reply to your coach…" : behavioralNow() ? "Ask, or answer the question…" : "Reply to your interviewer…";
  popHeader();
  // A reply that arrived since the last render scrolls into view, or lights the chat button when the window is hidden.
  const key = `${current}:${questions.length}`;
  if (pop.seen === null || !pop.seen.startsWith(current + ":")) { pop.seen = key; scrollPop(); return; }
  if (pop.seen === key) return;
  const fresh = questions.slice(Number(pop.seen.split(":").pop()));
  pop.seen = key;
  if (!fresh.some(q => q.answer)) return;
  if (popShowing()) scrollPop();
  else $("pop-unread").hidden = false;
}

function speakNewSentences(text, from) {
  if (!readAloud()) return from;
  const rest = text.slice(from);
  const match = rest.match(/^[\s\S]*[.!?](\s|$)/);
  if (!match) return from;
  const sentence = match[0].trim();
  if (sentence) say(sentence);
  return from + match[0].length;
}

async function coachChat(body) {
  if (pop.streaming) return;
  pop.streaming = true;
  $("pop-toggle").classList.add("busy");
  const live = $("pop-text");
  const empty = $("pop-log").querySelector(".pop-empty");
  if (empty) empty.remove();
  live.innerHTML = (body.message && body.trigger === undefined ? popLine("you", body.message, body.voice ? "🎙 You" : "") : "")
    + `<div class="pop-line them${body.trigger === "hint" ? " hint" : ""}"><small>${body.trigger === "hint" ? "Hint" : coachNow() ? "Coach" : "Interviewer"}</small><span class="pop-stream"><span class="typing"><i></i><i></i><i></i></span></span></div>`;
  const stream = live.querySelector(".pop-stream");
  popHeader("typing…");
  scrollPop();
  let text = "", spoken = 0, failed = false;
  try {
    const response = await fetch("api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interview: current, ...body }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `The coach is unavailable (${response.status}).`); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.text) {
          text += event.text;
          stream.textContent = text;
          scrollPop();
          spoken = speakNewSentences(text, spoken);
        } else if ("fallback" in event) {
          text = event.entry ? event.entry.answer : "";
          if (text) { stream.textContent = text; say(text); spoken = text.length; }
          latest.coach_ai = { ...latest.coach_ai, available: false };
          toast("Claude isn't reachable, so the scripted coach answered.");
        }
      }
    }
    if (spoken < text.length) say(text.slice(spoken).trim());
  } catch (e) {
    failed = true;
    stream.textContent = e.message;
    stream.parentElement.classList.add("error");
  }
  pop.streaming = false;
  $("pop-toggle").classList.remove("busy");
  await refresh();   // the reply is now in the conversation, so the live copy goes
  if (!failed) live.innerHTML = "";
  popHeader();
  scrollPop();
}

// A statement said aloud gets a short reply from the coach when you pause, at most every 20 seconds.
let lastThinkingReply = 0, thought = [];
function coachOnThinking(text) {
  // Everything you've said since the coach last replied, so it responds to your train of thought, not one fragment.
  thought.push(text);
  const coach = latest.session.state.mode === "coach";
  if (!coach && !phaseNow().nudge) return;   // a real interviewer lets you code in peace
  const said = thought.join(" ");
  if (said.split(/\s+/).length < 8 || Date.now() - lastThinkingReply < (coach ? 15000 : 45000)) return;
  clearTimeout(voice.nudgeTimer);
  const spokeAt = voice.spokeAt;
  voice.nudgeTimer = setTimeout(() => {
    if (voice.spokeAt !== spokeAt || voice.speaking || pop.streaming) return;
    lastThinkingReply = Date.now();
    thought = [];
    coachChat({ trigger: "thinking", message: said.slice(-1500) });
  }, 3000);
}

const HINT_ASK = /\b(hint|i'?m stuck|stuck|give me a clue|clue|nudge|help me out|can you help)\b/i;
const problemNow = () => latest && latest.session.started && latest.interview.format === "problem";
let lastActivity = Date.now(), lastNudge = 0;
const active = () => { lastActivity = Date.now(); };

async function askForHint() {
  if (!problemNow()) return;
  if (latest.session.state.mode !== "coach" && !askForHint.confirmed) {
    if (!confirm("In real mode a hint lowers your problem-solving score, like leaning on a real interviewer would. Get a hint?")) return;
    askForHint.confirmed = true;
  }
  if (aiOn()) { active(); return coachChat({ trigger: "hint" }); }
  active();
  try {
    const { entry } = await call("/api/hint", {});
    if (!popShowing()) showTab("interviewer");
    await refresh();
    say(entry.answer);
    if (!popShowing()) toast("Hint added to the Interviewer chat.");
  } catch (e) { toast(e.message); }
}

// Practice out loud: resume the mic if you left it on, otherwise invite you once per session.
const offered = new Set();
function offerVoice(data) {
  if (inLobby || !data.session.started || data.session.state.status !== "running" || voice.on || data.interview.format !== "problem") return;
  const key = `${current}:${data.session.state.started_at}`;
  if (offered.has(key)) return;
  offered.add(key);
  if (recall("lab.mic") === "on") { startVoice(); return; }
  setTimeout(() => {
    if (voice.on || pop.streaming || !popOpen()) return;
    const coach = data.session.state.mode === "coach";
    $("pop-text").innerHTML = `<div class="pop-line them"><small>${coach ? "Coach" : "Interviewer"}</small>${escapeHtml(coach ? "Practice out loud: turn on your mic and talk me through your thinking as you code. I'll listen and jump in when it helps." : "Real interviews are spoken. Turn on your mic and talk me through your thinking as you code.")}<br><button type="button" class="pop-action" id="pop-start-mic">Turn on mic (${MIC_KEY})</button></div>`;
    $("pop-start-mic").onclick = () => startVoice();
    scrollPop();
    say(coach ? "Practice out loud: turn on your mic and talk me through your thinking as you code." : "Real interviews are spoken. Turn on your mic and talk me through your thinking as you code.");
  }, 1500);
}

async function coachSays(entry) {
  if (!entry) return;
  await refresh();
  say(entry.answer);
  if (!popShowing()) toast((latest.session.state.mode === "coach" ? "Coach: " : "") + entry.answer.slice(0, 140) + (entry.answer.length > 140 ? "…" : ""));
}

function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
  if (name === "change" && latest && latest.session.change) { changeSeen = true; $("change-new").hidden = true; }
  if (name === "interviewer") setTimeout(() => $("question").focus(), 0);
}

function showConsole(name) {
  document.querySelectorAll("[data-console]").forEach(tab => tab.classList.toggle("active", tab.dataset.console === name));
  document.querySelectorAll("[data-console-panel]").forEach(panel => { panel.hidden = panel.dataset.consolePanel !== name; });
}

let renderedFor = null;
function render(data) {
  latest = data;
  renderApi(data.api);
  const info = data.interview;
  $("intro-level").textContent = `${info.level} · ${info.duration_minutes} minutes`;
  $("intro-title").textContent = info.title;
  $("intro-inspired").textContent = info.inspired_by;
  const isProblem = info.format === "problem";
  $("launch-mode").hidden = !isProblem;
  $("launch-mode").className = "mode-chip" + (lobbyMode === "coach" ? " coach" : "");
  $("launch-mode").textContent = lobbyMode === "coach" ? "Coach mode" : "Real interviewer";
  $("ide-mode").hidden = !isProblem;
  $("hint").hidden = !isProblem || !info.hint_count;
  $("show-approach").hidden = !isProblem || !(data.session.started && data.session.state.mode === "coach");
  renderModeToggles();
  renderFlow(info);
  applyFormat(info);
  const session = data.session;
  const started = session.started;
  $("start").textContent = started ? (session.state.status === "submitted" ? "Open interview" : "Continue interview") : "Start interview";
  $("show-report").hidden = !data.has_report;
  showView();
  if (!started) return;
  tickBase = { elapsed: session.elapsed, at: Date.now() };
  if (renderedFor !== current) {
    $("task").innerHTML = markdown(data.task);
    $("test-result").className = "test-empty";
    $("test-result").innerHTML = info.run_tests_allowed
      ? "You haven't run the tests yet. Press <b>Run tests</b>; every run counts as evidence of how you checked your work."
      : "This round simulates Amazon's interview editor, which doesn't run code. Reason about correctness and <b>dry-run your code by hand</b> on the example. Grading runs your code after you submit.";
    $("console-summary").textContent = "";
  }
  $("workspace").textContent = data.workspace;
  $("cmd-editor").textContent = data.commands.editor;
  $("cmd-assistant").textContent = data.commands.assistant;
  $("cmd-tests").textContent = data.commands.tests;
  $("cmd-activate").textContent = data.commands.activate;
  const status = session.state.status;
  $("pause").hidden = status !== "running";
  $("resume").hidden = status !== "paused";
  $("reveal").hidden = session.state.change_revealed_at !== null;
  renderPhases(session);
  renderQuestions(session.state.questions, session.state.spoken || []);
  popNewMessages(session);
  cues(session);
  renderNotes(session.state.notes, renderedFor !== current);
  renderedFor = current;
  const revealed = !!session.change;
  $("change").hidden = !revealed;
  $("change-locked").hidden = revealed;
  $("change-tab").classList.toggle("revealed", revealed);
  $("change-icon").innerHTML = `<use href="#${revealed ? "i-bolt" : "i-lock"}"/>`;
  if (revealed) {
    $("change-text").innerHTML = markdown(session.change);
    if (!changeSeen) {
      $("change-new").hidden = false;
      if (render.announced !== current) {
        render.announced = current;
        if (session.state.change_reveal_reason) { toast("⚡ Requirement change revealed. Open the Change tab."); showTab("change"); }
      }
    }
  } else {
    $("change-new").hidden = true;
  }
  const files = info.editor_files || [];
  if (files.length && !code.path && !code.opening) { code.opening = true; openCode(files[0]).finally(() => { code.opening = false; }); }
  syncCode(data.files);
  offerVoice(data);
  renderTimer();
}

async function refresh() {
  try { render(await call(`/api/state?interview=${encodeURIComponent(current)}`)); }
  catch (error) { toast(error.message); }
}

function renderTests(result) {
  const failing = result.cases.filter(c => c.outcome !== "passed");
  const passing = result.cases.filter(c => c.outcome === "passed");
  const ok = result.ok && result.total > 0;
  $("console-summary").innerHTML = `<span style="color:var(--${ok ? "green" : "red"})">${result.passed}/${result.total} passed</span>`;
  $("test-result").className = "";
  const caseHtml = c => `<div class="case ${c.outcome === "passed" ? "pass" : "fail"}"><span class="badge">${c.outcome === "passed" ? "✓" : "✕"}</span><span class="name">${escapeHtml(c.name.replace(/^.*::/, ""))}${c.outcome !== "passed" && c.message ? `<span class="why">${escapeHtml(c.message)}</span>` : ""}</span></div>`;
  $("test-result").innerHTML = `
    <div class="test-head"><span class="verdict ${ok ? "ok" : "bad"}">${ok ? "All visible tests passed" : result.total ? `${result.failed + result.errors} failing` : "Tests could not run"}</span><span class="muted small">${result.passed} passed · ${result.failed} failed · ${result.errors} errors</span></div>
    <div class="test-grid">${failing.concat(passing).map(caseHtml).join("")}</div>
    <details class="raw"><summary>Raw pytest output</summary><pre>${escapeHtml(result.output)}</pre></details>`;
}

// Voice: the interviewer listens through the browser's speech recognition and answers with speech synthesis.

const recognitionClass = () => window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { on: false, rec: null, finals: "", silence: null, speaking: false, lastNudge: 0, nudgeTimer: null, local: false, spokeAt: 0 };
const FILLERS = /^(?:(?:so|oh|okay|ok|um+|uh+|hmm+|and|also|alright|all right|right|hey|well|yeah|wait|quick question|one more thing)[\s,]+)+/i;
const ASKS = /^(what|how|why|when|where|which|who|whose|should|shall|can|could|would|will|is|are|am|was|were|do|does|did|have|has|may|might|must|any)\b|\?\s*$|\b(can i|can you|could you|do you|should i|should we|is it|is there|are there|are we|what if|what about|how about|i was wondering|do we need|am i allowed)\b/i;

function isQuestion(text) { return ASKS.test(text.replace(FILLERS, "").trim()); }

function setVoiceUi(stateText, live) {
  const bar = $("voice-bar");
  bar.classList.toggle("on", voice.on && !voice.speaking);
  bar.classList.toggle("speaking", voice.speaking);
  $("mic").setAttribute("aria-pressed", String(voice.on));
  const top = $("mic-pill");
  top.classList.toggle("on", voice.on);
  top.classList.toggle("speaking", voice.on && voice.speaking);
  top.setAttribute("aria-pressed", String(voice.on));
  $("pop-mic").setAttribute("aria-pressed", String(voice.on));
  if (voice.on && $("pop-start-mic")) $("pop-text").innerHTML = "";   // the invitation is done once the mic is on
  if (!voice.on) $("mic-caption").textContent = `Talk (${MIC_KEY})`;
  else if (voice.speaking) $("mic-caption").textContent = "Speaking…";
  else if (live !== undefined && $("voice-bar").classList.contains("hearing")) $("mic-caption").textContent = live.slice(-48) || "Listening";
  else $("mic-caption").textContent = "Listening";
  top.classList.toggle("hearing", voice.on && $("voice-bar").classList.contains("hearing"));
  if (stateText) $("voice-state").textContent = stateText;
  if (live !== undefined) $("voice-live").textContent = live;
}

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter(v => /^en(-|_|$)/i.test(v.lang));
  // macOS, then Edge's natural voices on Windows, then Chrome's, then the older Windows voices.
  const preferred = ["Samantha", "Ava", "Aria", "Jenny", "Online (Natural)", "Google US English", "Allison", "Daniel", "Karen", "Alex", "Zira", "David"];
  return preferred.map(name => voices.find(v => v.name.includes(name))).find(Boolean) || voices.find(v => v.lang === "en-US") || voices[0] || null;
}

// Everything the interviewer says is read aloud unless you turn it off with the speaker button (separate from the mic).
const readAloud = () => "speechSynthesis" in window && $("speak-replies").checked;

function setReadAloud(on) {
  $("speak-replies").checked = on;
  remember("lab.readAloud", on ? "on" : "off");
  if (!on) hush();
  renderSpeaker();
}

function hush() {
  voice.queue = [];
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function renderSpeaker() {
  const on = $("speak-replies").checked, button = $("pop-speak");
  button.setAttribute("aria-pressed", String(on));
  button.classList.toggle("speaking", on && voice.speaking);
  button.title = on ? (voice.speaking ? "Reading aloud. Click to stop and mute" : "Replies are read aloud. Click to mute") : "Muted. Click to have replies read aloud";
  button.innerHTML = `<svg><use href="#${on ? "i-speaker" : "i-speaker-off"}"/></svg>`;
}

function speakable(text) {
  // What reads well out loud: no Markdown or code blocks, and complexities as words.
  return String(text)
    .replace(/```[\s\S]*?```/g, " (the code is in the chat) ")
    .replace(/[`*#]/g, "")
    .replace(/\bO\(([^()]{1,30})\)/g, "O of $1")
    .replace(/\b([a-z])\^2\b/g, "$1 squared")
    .replace(/\s+/g, " ")
    .trim();
}

function say(text) {
  if (!readAloud() || !text) return;
  // Sentence-sized pieces: long utterances can stall in some browsers, and a queue keeps replies in order.
  voice.queue = voice.queue || [];
  let piece = "";
  for (const sentence of speakable(text).match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || []) {
    if (piece && (piece + sentence).length > 220) { voice.queue.push(piece.trim()); piece = ""; }
    piece += sentence;
  }
  if (piece.trim()) voice.queue.push(piece.trim());
  if (!voice.speaking) speakNext();
}

function speakNext() {
  const text = (voice.queue || []).shift();
  if (!text) return;
  const utterance = new SpeechSynthesisUtterance(text.replace(/_/g, " "));
  const chosen = pickVoice();
  if (chosen) utterance.voice = chosen;
  utterance.rate = 1.03;
  utterance.onstart = () => {
    voice.speaking = true;                       // stop listening, so the interviewer does not hear itself
    try { voice.rec && voice.rec.abort(); } catch (e) { /* not running */ }
    setVoiceUi("Interviewer is speaking…", text);
    renderSpeaker();
  };
  const done = () => {
    voice.speaking = false;
    if ((voice.queue || []).length) { speakNext(); return; }
    if (voice.on) { setTimeout(listen, 250); setVoiceUi("Listening…", "Go ahead, I'm listening."); } else setVoiceUi("Talk to your interviewer");
    renderSpeaker();
  };
  utterance.onend = done;
  utterance.onerror = done;
  voice.speaking = true;
  speechSynthesis.speak(utterance);
}

function listen() {
  if (!voice.on || voice.speaking || !voice.rec) return;
  try { voice.rec.start(); } catch (e) { /* already started */ }
}

const phaseNow = () => (latest && latest.session.started ? latest.session.phases[latest.session.phase] || {} : {});
const behavioralNow = () => phaseNow().kind === "behavioral";

// While the interviewer asks Leadership Principles questions, what you say is your answer. After a pause it digs in.
async function behavioralNext() {
  try {
    const { entry } = await call("/api/behavioral", {});
    await refresh();
    if (entry) { say(entry.answer); return; }
    if (!behavioralNext.done && latest.session.state.behavioral && latest.session.state.behavioral.question >= 0) {
      behavioralNext.done = true;
      const line = "Thanks, that's all the behavioral questions I have. We'll move to the coding problem shortly.";
      toast(line);
      say(line);
    }
  } catch (e) { toast(e.message); }
}

async function answerBehavioral(text, typed) {
  try { await call("/api/answer", { text }); await refresh(); } catch (e) { toast(e.message); return; }
  if (typed) { behavioralNext(); return; }
  clearTimeout(voice.nudgeTimer);
  const spokeAt = voice.spokeAt;
  voice.nudgeTimer = setTimeout(() => {
    if (voice.spokeAt !== spokeAt || voice.speaking) return;   // still talking
    behavioralNext();
  }, 3500);
}

async function handleUtterance(text) {
  text = text.trim();
  if (text.split(/\s+/).length < 2 || !latest || !latest.session.started) return;
  if (problemNow() && HINT_ASK.test(text) && text.split(/\s+/).length < 15) { askForHint(); return; }
  if (aiOn()) {
    if (isQuestion(text)) { coachChat({ message: text, voice: true }); return; }
    try { await call("/api/speech", { text }); } catch (e) { /* still reply */ }
    setVoiceUi("Listening…", `Noted: “${text}”`);
    coachOnThinking(text);
    return;
  }
  if (behavioralNow() && !(isQuestion(text) && text.split(/\s+/).length < 20)) {
    setVoiceUi("Listening…", `“${text}”`);
    answerBehavioral(text, false);
    return;
  }
  if (isQuestion(text)) {
    setVoiceUi("Thinking…", `“${text}”`);
    try {
      const data = await call("/api/ask", { question: text, use_api: $("use-api").checked, voice: true });
      if (data.entry.api_error) toast(`API: ${data.entry.api_error.message} Answered offline instead.`);
      await refresh();
      say(data.entry.answer);
      if (!$("speak-replies").checked) setVoiceUi("Listening…", data.entry.answer);
    } catch (e) { toast(e.message); }
    return;
  }
  try { await call("/api/speech", { text }); refresh(); } catch (e) { toast(e.message); }
  setVoiceUi("Listening…", `Noted: “${text}”`);
  // While you plan or explain, the interviewer asks a follow-up when you pause after saying something substantial.
  const kind = phaseNow().nudge || null;
  if (!kind || text.split(/\s+/).length < 12 || Date.now() - voice.lastNudge < 40000) return;
  clearTimeout(voice.nudgeTimer);
  const spokeAt = voice.spokeAt;
  voice.nudgeTimer = setTimeout(async () => {
    if (voice.spokeAt !== spokeAt || voice.speaking || !voice.on) return;   // you kept talking
    voice.lastNudge = Date.now();
    try {
      const { entry } = await call("/api/followup", { phase: kind });
      if (entry) { await refresh(); say(entry.answer); }
    } catch (e) { /* no follow-up this time */ }
  }, 4000);
}

async function startVoice() {
  const Recognition = recognitionClass();
  if (!Recognition) { toast("This browser has no speech recognition. Use Chrome, Edge, or Safari, or type your questions."); return; }
  const rec = new Recognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  try {
    if (Recognition.available && await Recognition.available({ langs: ["en-US"], processLocally: true }) === "available") { rec.processLocally = true; voice.local = true; }
  } catch (e) { /* on-device recognition unavailable */ }
  rec.onresult = event => {
    if (voice.speaking) return;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) voice.finals += " " + piece; else interim += piece;
    }
    voice.spokeAt = Date.now();
    active();
    $("voice-bar").classList.add("hearing");
    setVoiceUi("Listening…", (voice.finals + " " + interim).trim());
    clearTimeout(voice.silence);
    voice.silence = setTimeout(() => {
      $("voice-bar").classList.remove("hearing");
      const text = voice.finals; voice.finals = "";
      handleUtterance(text);
    }, 1300);
  };
  rec.onerror = event => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") { stopVoice(false); toast("Microphone access was blocked. Allow it for this page in the address bar, then try again."); }
    else if (event.error === "network") toast("Speech recognition needs a network connection in this browser.");
    else if (event.error === "audio-capture") { stopVoice(); toast("No microphone was found. Plug one in or check System Settings → Sound → Input."); }
  };
  rec.onend = () => { if (voice.on && !voice.speaking) setTimeout(listen, 200); };
  voice.rec = rec;
  voice.on = true;
  remember("lab.mic", "on");
  listen();
  setVoiceUi("Listening…", voice.local ? "Speech is transcribed on this device." : "Your browser's speech service transcribes what you say (in Chrome, audio goes to Google).");
}

function stopVoice(forget = true) {
  if (forget) remember("lab.mic", "off");
  voice.on = false;
  clearTimeout(voice.silence); clearTimeout(voice.nudgeTimer);
  try { voice.rec && voice.rec.abort(); } catch (e) { /* not running */ }
  voice.rec = null; voice.finals = "";
  $("voice-bar").classList.remove("hearing");
  setVoiceUi("Talk to your interviewer", "Press the mic and speak. Questions get answered out loud; everything else is kept as your think-aloud.");
}

// The interviewer speaks up at each phase and when the requirement changes. The server says each line once.
async function cues(session) {
  if (session.state.status !== "running") return;
  const wanted = [];
  const phase = session.phases[session.phase];
  if (phase && phase.cue) wanted.push(phase.cue);
  if (session.change) wanted.push("change");
  for (const name of wanted) {
    if ((session.state.cues || []).includes(name) || cues.pending.has(name)) continue;
    cues.pending.add(name);
    try {
      const { entry } = await call("/api/cue", { cue: name });
      if (entry) {
        say(entry.answer);
        await refresh();
        if (phase && phase.kind === "behavioral" && name === phase.cue) behavioralNext();
      }
    } catch (e) { /* try again on the next refresh */ }
    cues.pending.delete(name);
  }
}
cues.pending = new Set();

// Results

function renderReport(report) {
  const t = report.tests;
  const percent = t.grading.total ? Math.round((t.grading.passed / t.grading.total) * 100) : 0;
  const ringColor = percent >= 80 ? "var(--green)" : percent >= 50 ? "var(--amber)" : "var(--red)";
  const names = { core: "Core", edge: "Edge cases", change: "Change" };
  const chips = Object.entries(t.grading_by_area).map(([area, b]) => `<span class="chip">${names[area] || area} <b>${b.passed}/${b.total}</b></span>`).join("");
  const list = items => items.length ? `<ul>${items.map(i => `<li>${i}</li>`).join("")}</ul>` : `<p class="none">None.</p>`;
  const missed = report.missed_cases.map(m => { const match = /^\[(\w+)\]\s*(.*)$/.exec(m); return match ? `<span class="area-tag ${match[1]}">${match[1]}</span>${escapeHtml(match[2])}` : escapeHtml(m); });
  const scored = report.scores.filter(s => s.score !== null);
  const average = scored.length ? (scored.reduce((sum, s) => sum + s.score, 0) / scored.length).toFixed(1) : "–";
  $("report-title").textContent = report.title;
  const lps = report.lp_breakdown || [];
  const lpColor = n => (n >= 4 ? "var(--green)" : n === 3 ? "var(--amber)" : "var(--red)");
  const lpSection = lps.length ? `<h3 class="section-title">Leadership Principles, story by story</h3>
    <div class="box"><table class="lp-table">${lps.map(l => `<tr><td class="lp">${escapeHtml(l.lp || "Story")}<div class="q">${escapeHtml(l.question)}</div></td><td class="n" style="color:${lpColor(l.score)}">${l.score}/5</td><td>${l.missing.length ? "Missing: " + escapeHtml(l.missing.join("; ")) : "Hit every signal."}</td></tr>`).join("")}</table></div>` : "";
  const lpAverage = lps.length ? lps.reduce((sum, l) => sum + l.score, 0) / lps.length : 0;
  const summary = report.behavioral_only ? `
    <section class="summary">
      <div class="ring" style="--p:${lpAverage * 20};--ring:${lpColor(Math.round(lpAverage))}"><div><b>${lps.length ? lpAverage.toFixed(1) : "–"}</b><span>avg story score</span></div></div>
      <div>
        <p class="eyebrow">Behavioral round report</p>
        <h2>${lps.length} of ${(latest && latest.session.state.behavioral && latest.session.state.behavioral.plan || []).length || lps.length} Leadership Principles answered</h2>
        <p>Average rubric score <b>${average}</b> across ${scored.length} observed area${scored.length === 1 ? "" : "s"} · ${report.elapsed_minutes} min</p>
        <div class="chips">${lps.map(l => `<span class="chip">${escapeHtml(l.lp || "Story")} <b>${l.score}/5</b></span>`).join("")}</div>
      </div>
    </section>` : null;
  $("report-body").innerHTML = (summary || `
    <section class="summary">
      <div class="ring" style="--p:${percent};--ring:${ringColor}"><div><b>${percent}%</b><span>grading tests</span></div></div>
      <div>
        <p class="eyebrow">Session report</p>
        <h2>${t.grading.passed} of ${t.grading.total} grading tests passed</h2>
        <p>Average rubric score <b>${average}</b> across ${scored.length} observed area${scored.length === 1 ? "" : "s"} · ${report.elapsed_minutes} min · requirement change ${report.change_revealed_at_minutes === null ? "not revealed" : `at ${report.change_revealed_at_minutes} min`}</p>
        <div class="chips">${chips}<span class="chip">Your new tests <b>${t.your_new_tests}</b></span><span class="chip">Catch starter bugs <b>${t.your_tests_that_catch_starter_bugs}</b></span>${t.your_tests ? `<span class="chip">Your suite <b>${t.your_tests.passed}/${t.your_tests.total}</b></span>` : ""}</div>
      </div>
    </section>`) + `

    <h3 class="section-title">Rubric</h3>
    <div class="scores">${report.scores.map(s => `
      <div class="score ${s.score === null ? "" : "s" + s.score}">
        <div class="score-top"><h4>${escapeHtml(s.label)}</h4>${s.score === null ? `<span class="num na">not observed</span>` : `<span class="num">${s.score}<small>/5</small></span>`}</div>
        <div class="meter">${[1, 2, 3, 4, 5].map(i => `<i class="${s.score && i <= s.score ? "on" : ""}"></i>`).join("")}</div>
        <details><summary>Evidence</summary><ul>${s.evidence.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul></details>
      </div>`).join("")}</div>

    ${lpSection}

    <div class="two"${report.behavioral_only ? ' style="grid-template-columns:1fr"' : ""}>
      ${report.behavioral_only ? "" : `<div><h3 class="section-title">Missed cases</h3><div class="box">${list(missed)}</div></div>`}
      <div><h3 class="section-title">Questionable assumptions</h3><div class="box">${list(report.questionable_assumptions.map(escapeHtml))}</div></div>
    </div>

    <h3 class="section-title">Three improvements</h3>
    <ol class="improve">${report.improvements.map(i => `<li><span>${escapeHtml(i)}</span></li>`).join("")}</ol>

    <h3 class="section-title">Follow-up exercise</h3>
    <div class="followup"><p class="eyebrow">Targets: ${escapeHtml(report.follow_up.label)}</p><p>${escapeHtml(report.follow_up.exercise)}</p></div>

    ${report.patch_review ? `<h3 class="section-title">The AI patch</h3>
    <div class="box spoiler"><details><summary>Show what was wrong with the patch</summary><p>${escapeHtml(report.patch_review.answer)}</p></details></div>` : ""}
    ${report.approach ? `<h3 class="section-title">How to solve it</h3><div class="solve md">${markdown(report.approach)}</div>` : ""}
    ${report.format_note ? `<p class="foot">${escapeHtml(report.format_note)}</p>` : ""}

    ${report.behavioral_only ? "" : `<details class="raw"><summary>Grading test output</summary><pre>${escapeHtml(t.grading_output || "")}</pre></details>`}
    <p class="foot">${escapeHtml(report.ai_usage_note)} ${escapeHtml(report.disclaimer)} Saved to <code>${escapeHtml(report.saved_to || "")}</code>.</p>`;
  $("api-feedback-text").innerHTML = "";
  $("report").hidden = false;
  showView();
  $("report").querySelector(".results-body").scrollTop = 0;
}

async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied.`); }
  catch (e) {
    const area = document.createElement("textarea");
    area.value = text; document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); toast(`${label} copied.`); } catch (err) { toast("Copy failed; select the text manually."); }
    area.remove();
  }
}

function popPointer(handle, event, onMove) {
  // Follows one pointer from press to release, then saves where the window ended up.
  const box = $("coach-pop");
  try { handle.setPointerCapture(event.pointerId); } catch (e) { /* keeps working without capture, just less smoothly */ }
  box.classList.add("moving");
  event.preventDefault();
  const move = e => onMove(e);
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    box.classList.remove("moving");
    const r = box.getBoundingClientRect();
    savePop(box.classList.contains("collapsed") ? { x: r.left, y: r.top, w: r.width } : { x: r.left, y: r.top, w: r.width, h: r.height });
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function labelShortcuts() {
  for (const id of ["mic-pill", "pop-mic"]) $(id).title = `Talk out loud (${MIC_KEY})`;
  $("mic-caption").textContent = `Talk (${MIC_KEY})`;
}

function wirePop() {
  const box = $("coach-pop");
  $("pop-head").addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button") || popDocked()) return;
    const r = box.getBoundingClientRect(), dx = event.clientX - r.left, dy = event.clientY - r.top;
    popPointer($("pop-head"), event, e => placePop({ ...popLayout(), x: e.clientX - dx, y: e.clientY - dy }));
  });
  $("pop-head").addEventListener("dblclick", event => { if (!event.target.closest("button")) setPop({ collapsed: !popLayout().collapsed }); });
  box.querySelectorAll("[data-edge]").forEach(grip => grip.addEventListener("pointerdown", event => {
    const edge = grip.dataset.edge;
    if (event.button !== 0 || popDocked()) return;
    const start = box.getBoundingClientRect(), x0 = event.clientX, y0 = event.clientY;
    popPointer(grip, event, e => {
      const dx = e.clientX - x0, dy = e.clientY - y0;
      let x = start.left, y = start.top, w = start.width, h = start.height;
      if (edge.includes("e")) w = Math.min(start.width + dx, window.innerWidth - 8 - start.left);
      if (edge.includes("w")) w = Math.min(start.width - dx, start.right - 8);
      if (edge.includes("s")) h = Math.min(start.height + dy, window.innerHeight - 8 - start.top);
      if (edge.includes("n")) h = Math.min(start.height - dy, start.bottom - 8);
      w = Math.max(POP_MIN.w, w);
      h = Math.max(POP_MIN.h, h);
      if (edge.includes("w")) x = start.right - w;
      if (edge.includes("n")) y = start.bottom - h;
      placePop({ ...popLayout(), x, y, w, h });
    });
  }));
  $("pop-min").onclick = () => setPop({ collapsed: !popLayout().collapsed });
  $("pop-close").onclick = () => setPop({ open: false });
  $("pop-toggle").onclick = () => { const l = popLayout(); setPop(l.open && !l.collapsed ? { open: false } : { open: true, collapsed: false }); };
  $("pop-log").addEventListener("click", event => { const link = event.target.closest("[data-open-tab]"); if (link) showTab(link.dataset.openTab); });
  $("pop-reply").onsubmit = event => {
    event.preventDefault();
    const text = $("pop-input").value.trim();
    if (!text) return;
    $("pop-input").value = "";
    active();
    if (problemNow() && HINT_ASK.test(text) && text.split(/\s+/).length < 15) askForHint();
    else if (aiOn()) coachChat({ message: text });
    else { $("question").value = text; $("ask-form").requestSubmit(); }
  };
  window.addEventListener("resize", () => { if (popOpen()) placePop(); });
  applyPop();
}

function wire() {
  $("start").onclick = async () => {
    if (latest && latest.session.started) { inLobby = false; showView(); return; }
    try {
      const reset = $("start-reset").checked;
      inLobby = false; changeSeen = false; behavioralNext.done = false;
      render(await call("/api/start", { reset, mode: lobbyMode }));
      showTab("problem");
      toast(reset ? "Workspace reset. The clock is running." : "The clock is running. Good luck!");
      loadInterviews();
    } catch (e) { inLobby = true; toast(e.message); }
  };
  $("back").onclick = () => { inLobby = true; loadInterviews(); showView(); };
  $("interview").onchange = () => { select($("interview").value); };
  $("menu-button").onclick = event => {
    event.stopPropagation();
    const open = $("menu").hidden;
    $("menu").hidden = !open;
    $("menu-button").setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", event => { if (!event.target.closest(".menu")) $("menu").hidden = true; });
  $("restart").onclick = async () => {
    if (!confirm("Restart the interview? The timer, questions, and notes start over.")) return;
    const reset = confirm("Also reset the workspace to the starter? Your changed and added files are moved to .practice-backup in the workspace, not deleted.\n\nOK = reset the workspace, Cancel = keep your files.");
    try { changeSeen = false; render.announced = null; behavioralNext.done = false; render(await call("/api/start", { reset, mode: latest && latest.session.state.mode || lobbyMode })); $("report").hidden = true; showView(); showTab("problem"); toast("Restarted."); } catch (e) { toast(e.message); }
  };
  $("pause").onclick = async () => { try { render(await call("/api/pause", {})); toast("Paused. Paused time doesn't count."); } catch (e) { toast(e.message); } };
  $("resume").onclick = async () => { try { render(await call("/api/resume", {})); } catch (e) { toast(e.message); } };
  $("reveal").onclick = async () => {
    if (!confirm("Reveal the requirement change now instead of at minute 30?")) return;
    try { render(await call("/api/reveal", {})); showTab("change"); } catch (e) { toast(e.message); }
  };
  $("reset-workspace").onclick = async () => {
    if (!confirm("Reset the workspace to the starter? Files you changed or added are moved to .practice-backup inside the workspace, not deleted. Files outside the workspace are never touched.")) return;
    try {
      const data = await call("/api/reset", {});
      render(data);
      toast(`Restored ${data.reset.restored.length} file(s); moved ${data.reset.moved_to_backup.length} to backup.`);
    } catch (e) { toast(e.message); }
  };
  document.querySelectorAll("[data-tab]").forEach(tab => tab.onclick = () => showTab(tab.dataset.tab));
  document.querySelectorAll("[data-note-tab]").forEach(tab => tab.onclick = () => showNote(tab.dataset.noteTab));
  document.querySelectorAll("[data-console]").forEach(tab => tab.onclick = () => showConsole(tab.dataset.console));
  $("ask-form").onsubmit = async event => {
    event.preventDefault();
    const question = $("question").value.trim();
    if (!question) return;
    $("question").disabled = true;
    active();
    if (problemNow() && HINT_ASK.test(question) && question.split(/\s+/).length < 15) {
      $("question").value = "";
      $("question").disabled = false;
      await askForHint();
      return;
    }
    if (aiOn()) {
      $("question").value = "";
      $("question").disabled = false;
      coachChat({ message: question });
      return;
    }
    if (behavioralNow() && !(isQuestion(question) && question.split(/\s+/).length < 20)) {
      $("question").value = "";
      await answerBehavioral(question, true);
      $("question").disabled = false;
      $("question").focus();
      return;
    }
    try {
      const data = await call("/api/ask", { question, use_api: $("use-api").checked });
      if (data.entry.api_error) toast(`API: ${data.entry.api_error.message} Answered offline instead.`);
      $("question").value = "";
      say(data.entry.answer);
      await refresh();
    } catch (e) { toast(e.message); }
    $("question").disabled = false;
    $("question").focus();
  };
  const timers = {};
  document.querySelectorAll("[data-note]").forEach(area => {
    area.addEventListener("scroll", () => { $("gutter").scrollTop = area.scrollTop; });
    area.addEventListener("keydown", event => {
      if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end"); area.dispatchEvent(new Event("input")); }
    });
    area.addEventListener("input", () => {
      updateGutter();
      document.querySelector(`[data-note-tab="${area.dataset.note}"]`).classList.toggle("filled", !!area.value.trim());
      $("saved").textContent = "Saving…";
      clearTimeout(timers[area.dataset.note]);
      timers[area.dataset.note] = setTimeout(async () => {
        try { await call("/api/note", { field: area.dataset.note, text: area.value }); $("saved").textContent = "✓ Saved"; }
        catch (e) { $("saved").textContent = "Not saved: " + e.message; }
      }, 600);
    });
  });
  $("run-tests").onclick = async () => {
    const button = $("run-tests");
    if (button.disabled) return;
    button.disabled = true; button.lastChild.textContent = "Running…";
    await saveCode();
    showConsole("tests");
    $("console-summary").innerHTML = `<span class="muted">running…</span>`;
    try {
      const { result, coach } = await call("/api/test", {});
      renderTests(result); active();
      if (coachAiOn()) { await refresh(); coachChat({ trigger: "tests" }); } else if (coach) coachSays(coach); else refresh();
    }
    catch (e) { toast(e.message); $("console-summary").textContent = ""; }
    button.disabled = false; button.lastChild.textContent = "Run tests";
  };
  $("run-custom").onclick = async () => {
    const button = $("run-custom");
    button.disabled = true;
    $("custom-status").textContent = "running…";
    await saveCode();
    try {
      const result = await call("/api/run", { code: $("custom-code").value });
      $("custom-output").innerHTML = escapeHtml(result.stdout) + (result.stderr ? `<span class="err">${escapeHtml(result.stderr)}</span>` : "") || '<span class="muted">(no output)</span>';
      $("custom-status").textContent = result.timed_out ? "stopped after 10 s" : result.ok ? "✓ ran" : "✕ error";
      refresh();
    } catch (e) { toast(e.message); $("custom-status").textContent = ""; }
    button.disabled = false;
  };
  $("custom-code").addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); $("run-custom").click(); }
    if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); $("custom-code").setRangeText("    ", $("custom-code").selectionStart, $("custom-code").selectionEnd, "end"); }
  });
  window.addEventListener("beforeunload", () => { if (code.dirty) saveCode(); });
  $("submit").onclick = async () => {
    if (!confirm("Submit for grading? This runs the hidden grading tests (about 10–30 seconds). You can keep working and resubmit.")) return;
    const button = $("submit");
    button.disabled = true; button.textContent = "Grading…";
    await saveCode();
    try { const data = await call("/api/submit", {}); renderReport(data.report); refresh(); } catch (e) { toast(e.message); }
    button.disabled = false; button.textContent = "Submit";
  };
  $("show-report").onclick = async () => {
    $("menu").hidden = true;
    try { const data = await call(`/api/report?interview=${encodeURIComponent(current)}`); if (data.report) renderReport(data.report); } catch (e) { toast(e.message); }
  };
  $("close-report").onclick = () => { $("report").hidden = true; inLobby = !(latest && latest.session.started); showView(); };
  $("copy-grading").onclick = async () => {
    try { const data = await call(`/api/packet?interview=${encodeURIComponent(current)}&kind=grading`); copyText(data.text, "Grading prompt"); } catch (e) { toast(e.message); }
  };
  $("copy-interviewer").onclick = async () => {
    $("menu").hidden = true;
    try { const data = await call(`/api/packet?interview=${encodeURIComponent(current)}&kind=interviewer`); copyText(data.text, "Interviewer prompt (paste it into a separate Claude conversation)"); } catch (e) { toast(e.message); }
  };
  $("api-feedback").onclick = async () => {
    const button = $("api-feedback");
    button.disabled = true;
    try {
      const data = await call("/api/feedback", {});
      if (data.api_error) toast(`API: ${data.api_error.message}`);
      else $("api-feedback-text").innerHTML = `<h3 class="section-title">API feedback · ${escapeHtml(data.model)} · ${data.usage.input_tokens} in / ${data.usage.output_tokens} out tokens</h3><div class="box">${markdown(data.feedback)}</div>`;
      refresh();
    } catch (e) { toast(e.message); }
    button.disabled = false;
  };
  document.querySelectorAll(".mode-toggle button").forEach(button => {
    button.onclick = async () => {
      const mode = button.dataset.mode;
      if (button.closest(".mode-toggle").id === "ide-mode" && latest && latest.session.started) {
        try {
          const before = latest.session.state.questions.length;
          render(await call("/api/mode", { mode }));
          const last = latest.session.state.questions.slice(-1)[0];
          if (last && latest.session.state.questions.length > before) say(last.answer);   // the interviewer announces the switch
        } catch (e) { toast(e.message); }
      } else {
        lobbyMode = mode;
        remember("lab.mode", mode);
        if (latest) render(latest);
      }
      renderModeToggles();
    };
  });
  $("hint").onclick = () => askForHint();
  wirePop();
  labelShortcuts();
  $("show-approach").onclick = async () => {
    $("menu").hidden = true;
    if (!confirm("Show the full approach? Try one more hint first if you haven't. The problem-solving score is capped at 3 once you've seen it.")) return;
    try { const { entry } = await call("/api/approach", {}); showTab("interviewer"); await refresh(); say("I've put the approach in the chat. Read it, then try writing it yourself without looking."); } catch (e) { toast(e.message); }
  };
  ["keydown", "pointerdown"].forEach(type => document.addEventListener(type, active, { passive: true }));
  setInterval(async () => {
    // The coach checks in when you've been quiet for two minutes while coding.
    if (!problemNow() || latest.session.state.status !== "running" || phaseNow().kind !== "coding") return;
    const coach = latest.session.state.mode === "coach";
    if (!coach && !aiOn()) return;
    if (Date.now() - lastActivity < (coach ? 120000 : 150000) || Date.now() - lastNudge < (coach ? 180000 : 240000) || voice.speaking || pop.streaming) return;
    lastNudge = Date.now();
    try { if (aiOn()) coachChat({ trigger: "nudge" }); else { const { entry } = await call("/api/nudge", {}); coachSays(entry); } } catch (e) { /* try later */ }
  }, 15000);
  const toggleMic = () => { if (voice.on) stopVoice(); else startVoice(); };
  $("mic-pill").onclick = toggleMic;
  $("pop-mic").onclick = toggleMic;
  document.addEventListener("keydown", event => {
    if (event.altKey && event.code === "KeyM" && latest && latest.session.started && !inLobby) { event.preventDefault(); toggleMic(); }
  });
  $("mic").onclick = () => { if (voice.on) stopVoice(); else { showTab("interviewer"); startVoice(); } };

  $("speak-replies").checked = recall("lab.readAloud") !== "off";
  $("speak-replies").onchange = () => setReadAloud($("speak-replies").checked);
  $("pop-speak").onclick = () => setReadAloud(!$("speak-replies").checked);
  renderSpeaker();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => pickVoice();
    document.querySelectorAll(".copy").forEach(button => { button.onclick = () => copyText($(button.dataset.copy).textContent, "Command"); });

  // Draggable split between the problem and the editor.
  const panes = $("panes"), splitter = $("splitter");
  const savedSplit = recall("lab.split");
  if (savedSplit) panes.style.setProperty("--left", savedSplit);
  splitter.addEventListener("pointerdown", event => {
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add("dragging");
    const move = e => {
      const rect = panes.getBoundingClientRect();
      const percent = Math.min(70, Math.max(25, ((e.clientX - rect.left) / rect.width) * 100));
      panes.style.setProperty("--left", `${percent}%`);
    };
    const up = () => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", move);
      remember("lab.split", panes.style.getPropertyValue("--left"));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
  });
}

(async function main() {
  if (location.pathname.startsWith("/practice")) { $("switch").href = "/"; $("switch-ide").href = "/"; }  // served by Roomside: same server
  wire();
  showNote("plan");
  try {
    await loadInterviews();
    await refresh();
    const s = latest && latest.session;
    inLobby = !(s && s.started && s.state.status !== "submitted");  // jump straight back into a running interview
    showView();
  } catch (e) { toast(e.message); }
  setInterval(renderTimer, 1000);
  setInterval(() => { if (latest && latest.session.started && latest.session.state.status === "running") refresh(); }, 15000);
})();
