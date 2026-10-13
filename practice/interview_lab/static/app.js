"use strict";

const $ = id => document.getElementById(id);
let current = null;      // interview id
let latest = null;       // last /api/state payload
let tickBase = null;     // {elapsed, at} for a smooth local clock
let changeShown = false;

function remember(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
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
function escapeHtml(text) { return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
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

async function loadInterviews() {
  const interviews = await call("/api/interviews");
  const select = $("interview");
  select.innerHTML = interviews.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.title)}</option>`).join("");
  const saved = recall("lab.interview");
  current = interviews.some(i => i.id === saved) ? saved : interviews[0].id;
  select.value = current;
  select.onchange = () => { current = select.value; remember("lab.interview", current); changeShown = false; $("report").hidden = true; refresh(); };
}

function renderApi(apiInfo) {
  const badge = $("api-badge");
  badge.textContent = apiInfo.ready ? `Interviewer: API · ${apiInfo.model} · billed per token` : apiInfo.enabled ? "Interviewer: API on, key missing · offline answers" : "Interviewer: offline · no API calls";
  badge.title = apiInfo.message + (apiInfo.usage && apiInfo.usage.requests ? ` This session: ${apiInfo.usage.requests} request(s), ${apiInfo.usage.input_tokens} input and ${apiInfo.usage.output_tokens} output tokens (cap ${apiInfo.max_requests_per_session} requests, ${apiInfo.max_output_tokens} output tokens each).` : "");
  badge.classList.toggle("api-on", apiInfo.enabled);
  $("use-api-wrap").hidden = !apiInfo.ready;
  $("api-feedback").hidden = !apiInfo.ready;
}

function renderPhases(session) {
  const changeAt = session.change_at / 60;
  const revealed = session.state.change_revealed_at !== null;
  const items = [];
  session.phases.forEach((phase, index) => {
    const state = index < session.phase ? "done" : index === session.phase ? "now" : "";
    items.push(`<li class="${state}"><span class="t">${phase.start}–${phase.end}</span><span>${escapeHtml(phase.name)}</span></li>`);
    if (phase.start <= changeAt && changeAt < phase.end) {
      items.push(`<li class="milestone"><span class="t">at ${changeAt}</span><span>${revealed ? "Requirement change revealed" : "Requirement change appears"}</span></li>`);
    }
  });
  $("phases").innerHTML = items.join("");
  $("change-tick").style.left = `${(changeAt / 60) * 100}%`;
  $("bar-fill").style.width = `${Math.min(100, (session.elapsed / 3600) * 100)}%`;
}

function renderTimer() {
  if (!latest || !latest.session.started) return;
  const session = latest.session;
  let elapsed = session.elapsed;
  if (session.state.status === "running" && tickBase) elapsed = tickBase.elapsed + (Date.now() - tickBase.at) / 1000;
  $("elapsed").textContent = clock(elapsed);
  $("bar-fill").style.width = `${Math.min(100, (elapsed / session.duration) * 100)}%`;
  const status = session.state.status;
  const remaining = session.duration - elapsed;
  $("timer-status").textContent = status === "paused" ? "Paused." : status === "submitted" ? "Submitted. You can keep working and submit again, or restart." : remaining > 0 ? `${clock(remaining)} left.` : "Time is up. Wrap up your explanation and submit.";
  if (status === "running" && !session.state.change_revealed_at && elapsed >= session.change_at && !renderTimer.asked) {
    renderTimer.asked = true;
    refresh().finally(() => { renderTimer.asked = false; });
  }
}

function renderQuestions(questions) {
  $("questions").innerHTML = questions.slice().reverse().map(q => `<li><div class="q">${escapeHtml(q.question)}</div><div class="a">${escapeHtml(q.answer)}</div><div class="meta">${clock(q.at)} · ${q.source === "api" ? "API interviewer" : "offline interviewer"}${q.topic ? " · " + escapeHtml(q.topic) : ""}</div></li>`).join("");
}

function renderNotes(notes, force) {
  document.querySelectorAll("[data-note]").forEach(area => {
    if (force || document.activeElement !== area) area.value = notes[area.dataset.note] || "";
  });
}

let lastInterviewRendered = null;
function render(data) {
  latest = data;
  renderApi(data.api);
  const info = data.interview;
  $("intro-level").textContent = info.level;
  $("intro-title").textContent = info.title;
  $("intro-summary").textContent = info.summary;
  $("intro-inspired").textContent = info.inspired_by;
  const session = data.session;
  const started = session.started;
  $("session").hidden = !started;
  $("start").textContent = started ? "Restart interview" : "Start interview";
  $("intro").hidden = started;
  $("show-report").hidden = !data.has_report;
  if (!started) return;
  tickBase = { elapsed: session.elapsed, at: Date.now() };
  $("task").innerHTML = markdown(data.task);
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
  renderNotes(session.state.notes, lastInterviewRendered !== current);
  lastInterviewRendered = current;
  if (session.change) {
    $("change").hidden = false;
    $("change-text").innerHTML = markdown(session.change);
    if (!changeShown) {
      changeShown = true;
      if (session.state.change_reveal_reason) {
        $("change").classList.add("flash");
        $("change").scrollIntoView({ block: "start" });
        toast("Requirement change revealed. It is also in CHANGE_REQUEST.md.");
      }
    }
  } else {
    $("change").hidden = true;
  }
  renderTimer();
}

async function refresh() {
  try { render(await call(`/api/state?interview=${encodeURIComponent(current)}`)); }
  catch (error) { toast(error.message); }
}

function renderReport(report) {
  const t = report.tests;
  const dots = n => `<span class="dots">${[1, 2, 3, 4, 5].map(i => `<i class="${n && i <= n ? "on" : ""}"></i>`).join("")}</span>`;
  const list = items => items.length ? `<ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`;
  const areaNames = { core: "core", edge: "edge cases", change: "requirement change" };
  const byArea = Object.entries(t.grading_by_area).map(([area, b]) => `${areaNames[area] || area} ${b.passed}/${b.total}`).join(" · ");
  $("report-body").innerHTML = `
    <p class="muted small">Submitted ${escapeHtml(report.submitted)} after ${report.elapsed_minutes} min · requirement change ${report.change_revealed_at_minutes === null ? "not revealed" : "revealed at " + report.change_revealed_at_minutes + " min"} · saved to <code>${escapeHtml(report.saved_to || "")}</code></p>
    <h3>Test results</h3>
    <p><span class="${t.grading.failed + t.grading.errors ? "fail" : "pass"}">Grading tests: ${t.grading.passed} of ${t.grading.total} passed</span> (${escapeHtml(byArea)}).<br>
    ${t.your_tests ? `Your tests: ${t.your_tests.passed} passed, ${t.your_tests.failed} failed, ${t.your_tests.errors} errors. ` : ""}New tests you wrote: ${t.your_new_tests}; of those, ${t.your_tests_that_catch_starter_bugs} fail on the original starter (they catch real bugs).</p>
    <h3>Scores</h3>
    <table class="scores">${report.scores.map(s => `<tr><td>${escapeHtml(s.label)}<details><summary>Evidence</summary>${list(s.evidence)}</details></td><td class="n">${s.score === null ? '<span class="muted">not observed</span>' : dots(s.score) + s.score + "/5"}</td></tr>`).join("")}</table>
    <h3>Missed cases</h3>${list(report.missed_cases)}
    <h3>Questionable assumptions</h3>${list(report.questionable_assumptions)}
    <h3>Three improvements</h3><ol>${report.improvements.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ol>
    <h3>Follow-up exercise: ${escapeHtml(report.follow_up.label)}</h3><p>${escapeHtml(report.follow_up.exercise)}</p>
    <h3>The AI patch</h3><p>${escapeHtml(report.patch_review.answer)}</p>
    <details><summary>Grading test output</summary><pre>${escapeHtml(t.grading_output || "")}</pre></details>
    <p class="muted small">${escapeHtml(report.ai_usage_note)} ${escapeHtml(report.disclaimer)}</p>`;
  $("api-feedback-text").innerHTML = "";
  $("report").hidden = false;
  $("report").scrollIntoView({ block: "start" });
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
    const started = latest && latest.session.started;
    if (started && !confirm("Restart the timer and clear this session's questions and notes?")) return;
    const reset = $("start-reset").checked;
    try { render(await call("/api/start", { reset })); changeShown = false; toast(reset ? "Workspace reset. Timer started." : "Timer started."); } catch (e) { toast(e.message); }
  };
  $("restart").onclick = async () => {
    if (!confirm("Restart the interview? The timer, questions, and notes start over.")) return;
    const reset = confirm("Also reset the workspace to the starter? Your changed and added files are moved to .practice-backup in the workspace, not deleted.\n\nOK = reset the workspace, Cancel = keep your files.");
    try { render(await call("/api/start", { reset })); changeShown = false; $("report").hidden = true; toast("Restarted."); } catch (e) { toast(e.message); }
  };
  $("pause").onclick = async () => { try { render(await call("/api/pause", {})); } catch (e) { toast(e.message); } };
  $("resume").onclick = async () => { try { render(await call("/api/resume", {})); } catch (e) { toast(e.message); } };
  $("reveal").onclick = async () => {
    if (!confirm("Reveal the requirement change now instead of at minute 30?")) return;
    try { render(await call("/api/reveal", {})); } catch (e) { toast(e.message); }
  };
  $("reset-workspace").onclick = async () => {
    if (!confirm("Reset the workspace to the starter? Files you changed or added are moved to .practice-backup inside the workspace, not deleted. Files outside the workspace are never touched.")) return;
    try {
      const data = await call("/api/reset", {});
      render(data);
      const r = data.reset;
      toast(`Restored ${r.restored.length} file(s); moved ${r.moved_to_backup.length} to backup.`);
    } catch (e) { toast(e.message); }
  };
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
    area.addEventListener("input", () => {
      $("saved").textContent = "Saving…";
      clearTimeout(timers[area.dataset.note]);
      timers[area.dataset.note] = setTimeout(async () => {
        try { await call("/api/note", { field: area.dataset.note, text: area.value }); $("saved").textContent = "Saved"; }
        catch (e) { $("saved").textContent = "Not saved: " + e.message; }
      }, 600);
    });
  });
  $("run-tests").onclick = async () => {
    const button = $("run-tests");
    button.disabled = true; button.textContent = "Running…";
    try {
      const { result } = await call("/api/test", {});
      const failing = result.cases.filter(c => c.outcome !== "passed");
      $("test-result").innerHTML = `<p class="${result.ok ? "pass" : "fail"}">${result.passed} passed, ${result.failed} failed, ${result.errors} errors</p>` +
        (failing.length ? `<ul class="cases">${failing.map(c => `<li class="fail">✗ ${escapeHtml(c.name)}${c.message ? " — " + escapeHtml(c.message) : ""}</li>`).join("")}</ul>` : "") +
        `<details><summary>Output</summary><pre>${escapeHtml(result.output)}</pre></details>`;
      refresh();
    } catch (e) { toast(e.message); }
    button.disabled = false; button.textContent = "Run visible tests";
  };
  $("submit").onclick = async () => {
    if (!confirm("Submit this session for grading? This runs the hidden grading tests (about 10–30 seconds).")) return;
    const button = $("submit");
    button.disabled = true; button.textContent = "Grading…";
    try { const data = await call("/api/submit", {}); renderReport(data.report); refresh(); } catch (e) { toast(e.message); }
    button.disabled = false; button.textContent = "Submit session";
  };
  $("show-report").onclick = async () => {
    try { const data = await call(`/api/report?interview=${encodeURIComponent(current)}`); if (data.report) renderReport(data.report); } catch (e) { toast(e.message); }
  };
  $("close-report").onclick = () => { $("report").hidden = true; };
  $("copy-grading").onclick = async () => {
    try { const data = await call(`/api/packet?interview=${encodeURIComponent(current)}&kind=grading`); copyText(data.text, "Grading prompt"); } catch (e) { toast(e.message); }
  };
  $("copy-interviewer").onclick = async () => {
    try { const data = await call(`/api/packet?interview=${encodeURIComponent(current)}&kind=interviewer`); copyText(data.text, "Interviewer prompt"); } catch (e) { toast(e.message); }
  };
  $("api-feedback").onclick = async () => {
    const button = $("api-feedback");
    button.disabled = true; button.textContent = "Asking the API…";
    try {
      const data = await call("/api/feedback", {});
      if (data.api_error) toast(`API: ${data.api_error.message}`);
      else $("api-feedback-text").innerHTML = `<h3>API feedback (${escapeHtml(data.model)}, ${data.usage.input_tokens} in / ${data.usage.output_tokens} out tokens)</h3>` + markdown(data.feedback);
      refresh();
    } catch (e) { toast(e.message); }
    button.disabled = false; button.textContent = "Get API feedback";
  };
  document.querySelectorAll(".copy").forEach(button => { button.onclick = () => copyText($(button.dataset.copy).textContent, "Command"); });
}

(async function main() {
  if (location.pathname.startsWith("/practice")) $("switch").href = "/";  // served by Roomside: same server
  wire();
  try { await loadInterviews(); await refresh(); } catch (e) { toast(e.message); }
  setInterval(renderTimer, 1000);
  setInterval(() => { if (latest && latest.session.started && latest.session.state.status === "running") refresh(); }, 15000);
})();
