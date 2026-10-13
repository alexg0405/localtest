"use strict";

const $ = id => document.getElementById(id);
let current = null;        // interview id
let interviews = [];       // lobby list
let latest = null;         // last /api/state payload
let tickBase = null;       // {elapsed, at}: a smooth local clock between polls
let inLobby = true;
let changeSeen = false;    // the candidate has opened the Change tab since it was revealed
let activeNote = "plan";

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
const DOMAINS = { "commerce-orders": ["commerce", "Commerce"], "banking-ledger": ["banking", "Banking"], "unfamiliar-repo": ["repo", "Unfamiliar repo"] };

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
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}
function markdown(source) {
  const lines = source.replace(/\r/g, "").split("\n");
  let html = "", list = null, paragraph = [], code = null;
  const flush = () => { if (paragraph.length) { html += `<p>${inline(paragraph.join(" "))}</p>`; paragraph = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
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
      flush();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
      html += `<li>${inline((bullet || numbered)[1])}</li>`;
    } else if (!line.trim()) { flush(); closeList(); }
    else if (list && /^\s{2,}\S/.test(line)) { html = html.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`); }
    else { closeList(); paragraph.push(line.trim()); }
  }
  if (code !== null) html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
  flush(); closeList();
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

function renderCards() {
  $("lobby-cards").innerHTML = interviews.map(i => {
    const [cls, label] = DOMAINS[i.id] || ["repo", "Interview"];
    const status = i.status === "running" || i.status === "paused" ? `<span class="status running">${i.status === "paused" ? "Paused" : "In progress"}</span>` : i.status === "submitted" ? `<span class="status submitted">Submitted</span>` : "";
    return `<button class="card${i.id === current ? " selected" : ""}" role="listitem" data-id="${escapeHtml(i.id)}">
      <div class="card-top"><span class="domain ${cls}"><i></i>${label}</span>${status}</div>
      <h3>${escapeHtml(i.title)}</h3>
      <p>${escapeHtml(i.summary)}</p>
      <div class="card-meta"><span class="tag">python</span><span class="tag">pytest</span><span class="tag">${i.duration_minutes} min</span><span class="tag">junior</span></div>
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
  if (view !== showView.last) { window.scrollTo(0, 0); showView.last = view; }
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
  $("change-tick").style.left = `calc(${(session.change_at / session.duration) * 100}% - 1px)`;
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
  if (status === "running" && session.state.change_revealed_at === null && elapsed >= session.change_at && !renderTimer.asked) {
    renderTimer.asked = true;
    refresh().finally(() => { renderTimer.asked = false; });
  }
}

function renderQuestions(questions) {
  $("q-count").hidden = !questions.length;
  $("q-count").textContent = questions.length;
  if (!questions.length) {
    $("questions").innerHTML = `<div class="chat-empty"><h3>Ask before you build</h3><p>The interviewer answers clarifying questions about requirements. Strong candidates ask a few in the first five minutes.</p><div class="suggest">${SUGGESTED.map(s => `<button type="button">${escapeHtml(s)}</button>`).join("")}</div></div>`;
    document.querySelectorAll(".suggest button").forEach(b => b.onclick = () => { $("question").value = b.textContent; $("question").focus(); });
    return;
  }
  $("questions").innerHTML = questions.map(q => `
    <div class="msg you"><div class="avatar">You</div><div><div class="bubble">${escapeHtml(q.question)}</div><div class="meta">${clock(q.at)}</div></div></div>
    <div class="msg them"><div class="avatar">IV</div><div><div class="bubble">${escapeHtml(q.answer)}</div><div class="meta">${q.source === "api" ? "API interviewer" : "Interviewer"}${q.topic ? " · " + escapeHtml(q.topic) : ""}</div></div></div>`).join("");
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
  document.querySelectorAll("[data-note-tab]").forEach(tab => tab.classList.toggle("active", tab.dataset.noteTab === name));
  document.querySelectorAll("[data-note]").forEach(area => { area.hidden = area.dataset.note !== name; });
  const area = document.querySelector(`[data-note="${name}"]`);
  area.placeholder = NOTES[name].placeholder;
  $("editor-hint").innerHTML = NOTES[name].hint;
  $("status-note").textContent = name === "transcript" ? "Plain text" : "Markdown";
  updateGutter();
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
    $("test-result").innerHTML = "You haven't run the tests yet. Press <b>Run tests</b>; every run counts as evidence of how you checked your work.";
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
  renderQuestions(session.state.questions);
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
  $("report-body").innerHTML = `
    <section class="summary">
      <div class="ring" style="--p:${percent};--ring:${ringColor}"><div><b>${percent}%</b><span>grading tests</span></div></div>
      <div>
        <p class="eyebrow">Session report</p>
        <h2>${t.grading.passed} of ${t.grading.total} grading tests passed</h2>
        <p>Average rubric score <b>${average}</b> across ${scored.length} observed area${scored.length === 1 ? "" : "s"} · ${report.elapsed_minutes} min · requirement change ${report.change_revealed_at_minutes === null ? "not revealed" : `at ${report.change_revealed_at_minutes} min`}</p>
        <div class="chips">${chips}<span class="chip">Your new tests <b>${t.your_new_tests}</b></span><span class="chip">Catch starter bugs <b>${t.your_tests_that_catch_starter_bugs}</b></span>${t.your_tests ? `<span class="chip">Your suite <b>${t.your_tests.passed}/${t.your_tests.total}</b></span>` : ""}</div>
      </div>
    </section>

    <h3 class="section-title">Rubric</h3>
    <div class="scores">${report.scores.map(s => `
      <div class="score ${s.score === null ? "" : "s" + s.score}">
        <div class="score-top"><h4>${escapeHtml(s.label)}</h4>${s.score === null ? `<span class="num na">not observed</span>` : `<span class="num">${s.score}<small>/5</small></span>`}</div>
        <div class="meter">${[1, 2, 3, 4, 5].map(i => `<i class="${s.score && i <= s.score ? "on" : ""}"></i>`).join("")}</div>
        <details><summary>Evidence</summary><ul>${s.evidence.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul></details>
      </div>`).join("")}</div>

    <div class="two">
      <div><h3 class="section-title">Missed cases</h3><div class="box">${list(missed)}</div></div>
      <div><h3 class="section-title">Questionable assumptions</h3><div class="box">${list(report.questionable_assumptions.map(escapeHtml))}</div></div>
    </div>

    <h3 class="section-title">Three improvements</h3>
    <ol class="improve">${report.improvements.map(i => `<li><span>${escapeHtml(i)}</span></li>`).join("")}</ol>

    <h3 class="section-title">Follow-up exercise</h3>
    <div class="followup"><p class="eyebrow">Targets: ${escapeHtml(report.follow_up.label)}</p><p>${escapeHtml(report.follow_up.exercise)}</p></div>

    <h3 class="section-title">The AI patch</h3>
    <div class="box spoiler"><details><summary>Show what was wrong with the patch</summary><p>${escapeHtml(report.patch_review.answer)}</p></details></div>

    <details class="raw"><summary>Grading test output</summary><pre>${escapeHtml(t.grading_output || "")}</pre></details>
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

function wire() {
  $("start").onclick = async () => {
    if (latest && latest.session.started) { inLobby = false; showView(); return; }
    try {
      const reset = $("start-reset").checked;
      inLobby = false; changeSeen = false;
      render(await call("/api/start", { reset }));
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
    try { changeSeen = false; render.announced = null; render(await call("/api/start", { reset })); $("report").hidden = true; showView(); showTab("problem"); toast("Restarted."); } catch (e) { toast(e.message); }
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
    try {
      const data = await call("/api/ask", { question, use_api: $("use-api").checked });
      if (data.entry.api_error) toast(`API: ${data.entry.api_error.message} Answered offline instead.`);
      $("question").value = "";
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
    button.disabled = true; button.lastChild.textContent = "Running…";
    showConsole("tests");
    $("console-summary").innerHTML = `<span class="muted">running…</span>`;
    try { const { result } = await call("/api/test", {}); renderTests(result); refresh(); }
    catch (e) { toast(e.message); $("console-summary").textContent = ""; }
    button.disabled = false; button.lastChild.textContent = "Run tests";
  };
  $("submit").onclick = async () => {
    if (!confirm("Submit for grading? This runs the hidden grading tests (about 10–30 seconds). You can keep working and resubmit.")) return;
    const button = $("submit");
    button.disabled = true; button.textContent = "Grading…";
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
