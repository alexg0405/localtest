"""Self-check: proves each interview works end to end, in a throwaway PRACTICE_HOME.

Checks, for every interview: the workspace holds no interviewer materials; starter
defects are caught by the visible and grading tests; the reference solution passes
everything; the AI patch applies and its mistake is caught; the requirement change
appears at minute 30 (and not during a pause); reset restores the starter without
deleting anything; and the whole dashboard workflow runs with no API key.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, List

from . import api, grading
from .catalog import LAB_ROOT, all_interviews, practice_home, test_python
from .session import CHANGE_FILE, Sessions
from .testing import run_pytest
from .workspace import BACKUP_DIR, build_starter, create_workspace, iter_files, reset_workspace, workspace_path

# A regression test a candidate might write for each interview (fails on the starter, passes once fixed).
CANDIDATE_TESTS = {
    "commerce-orders": '''from orders.inventory import InventoryStore
from orders.models import LineItem
from orders.payments import FakePaymentGateway
from orders.service import OrderService


def test_declined_card_is_tried_once():
    gateway = FakePaymentGateway(["declined", "ok"])
    service = OrderService(InventoryStore({"A": 5}), gateway, sleep=lambda seconds: None)
    try:
        service.place_order("r1", "c1", [LineItem("A", 1, 100)])
    except Exception:
        pass
    assert gateway.calls == 1
''',
    "banking-ledger": '''from ledger.money import parse_amount


def test_awkward_amount_is_exact():
    assert parse_amount("4.35") == 435
''',
    "amazon-final-1": '''from deliveries.late_carriers import top_late_carriers


def test_tie_is_alphabetical():
    assert top_late_carriers([("a", "Zed", 1, 2), ("b", "Amy", 1, 2)], 2) == ["Amy", "Zed"]
''',
    "amazon-final-2": '''from fulfillment.robot_moves import min_moves


def test_unreachable():
    assert min_moves(["D#P"]) == -1
''',
    "unfamiliar-repo": '''import json

from pipeline.cli import main


def test_bom_feed_imports(tmp_path):
    (tmp_path / "feed.csv").write_bytes(b"\\xef\\xbb\\xbfsku,name,price\\nA-1,Caf\\xc3\\xa9,1.00\\n")
    (tmp_path / "config.json").write_text(json.dumps({"input": "feed.csv", "output": "out.json"}))
    assert main([str(tmp_path / "config.json"), "--quiet"]) == 0
    assert json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))[0]["name"] == "Café"
''',
}


class Checker:
    def __init__(self) -> None:
        self.failures: List[str] = []

    def check(self, label: str, ok: bool, detail: str = "") -> bool:
        print(f"  {'✓' if ok else '✗'} {label}" + (f" ({detail})" if detail else ""))
        if not ok:
            self.failures.append(label)
        return ok


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


def _overlay(source: Path, target: Path) -> None:
    for relative, path in iter_files(source).items():
        (target / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target / relative)


def _hidden_run(python: str, interview, folder: Path) -> dict:
    shutil.copytree(interview.starter / "tests", folder / "_original_tests", dirs_exist_ok=True)
    shutil.copytree(interview.grading_tests, folder / "_grading_tests", dirs_exist_ok=True)
    return run_pytest(python, folder, ["_original_tests", "_grading_tests"])


def _http(port: int, path: str, body=None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def verify_interview(interview, home: Path, python: str, c: Checker) -> None:
    print(f"\n{interview.title} [{interview.id}]")
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)

        # 1. Candidate workspace holds only candidate materials.
        workspace = create_workspace(interview, home)
        files = iter_files(workspace)
        guide_lines = [line for line in interview.guide().splitlines() if len(line) > 60][:5]
        leaked = [r for r in files if "interviewer" in r or r.startswith("_grading") or "grading" in Path(r).name]
        leaked += [r for r, p in files.items() if p.suffix in (".md", ".py") and any(g in p.read_text(encoding="utf-8") for g in guide_lines)]
        c.check("workspace contains no interviewer materials", not leaked, ", ".join(leaked))
        settings = json.loads((workspace / ".claude" / "settings.json").read_text())
        c.check("CLAUDE.md and assistant deny rules are in place", (workspace / "CLAUDE.md").exists() and any(str(LAB_ROOT) in rule for rule in settings["permissions"]["deny"]))

        if interview.meta.get("format") == "amazon-behavioral":
            verify_behavioral_round(interview, home, workspace, scratch, c)
            return
        if interview.meta.get("format") == "problem":
            verify_problem(interview, home, python, workspace, scratch, c)
            return

        # 2. Starter defects are detectable.
        visible = run_pytest(python, workspace, ["tests"])
        blank = interview.meta.get("format") == "amazon-final"  # an empty function to write, not planted bugs
        c.check("starter fails visible tests", visible["failed"] + visible["errors"] > 0 and (blank or visible["passed"] > 0), f"{visible['passed']} pass, {visible['failed']} fail")
        starter = scratch / "starter"
        build_starter(interview, starter, home)
        hidden = _hidden_run(python, interview, starter)
        c.check("starter fails grading tests", hidden["failed"] + hidden["errors"] > 0, f"{hidden['failed']} of {hidden['total']} fail")

        # 3. Reference solution passes everything.
        solved = scratch / "solved"
        build_starter(interview, solved, home)
        _overlay(interview.solution, solved)
        solved_visible = run_pytest(python, solved, ["tests"])
        solved_hidden = _hidden_run(python, interview, solved)
        c.check("reference solution passes visible and grading tests",
                solved_visible["ok"] and solved_hidden["ok"] and solved_hidden["total"] > 0,
                f"{solved_visible['passed']} visible, {solved_hidden['passed']}/{solved_hidden['total']} grading")

        # 4. The AI patch applies and its planted mistake is caught.
        if not (interview.starter / "patch_review" / "ai_patch.diff").exists():
            c.check("no-AI round: the workspace tells the assistant not to help", "Do not help with the exercise" in (workspace / "CLAUDE.md").read_text(encoding="utf-8"))
        patched = scratch / "patched"
        build_starter(interview, patched, home)
        subprocess.run(["git", "init", "-q"], cwd=patched, check=True)
        has_patch = (patched / "patch_review" / "ai_patch.diff").exists()
        applied = subprocess.run(["git", "apply", "patch_review/ai_patch.diff"], cwd=patched, capture_output=True, text=True) if has_patch else None
        if has_patch:
            c.check("AI patch applies to the starter", applied.returncode == 0, applied.stderr.strip()[:200])
        if has_patch and applied.returncode == 0:
            patched_hidden = _hidden_run(python, interview, patched)
            c.check("AI patch's mistake is caught by grading tests", patched_hidden["failed"] + patched_hidden["errors"] > 0, f"{patched_hidden['failed']} grading failures")

        # 5. The requirement change appears at minute 30, not before, and pauses do not count.
        clock = FakeClock()
        sessions = Sessions(home, clock=clock)
        sessions.start(interview, reset=True)
        clock.now += 10 * 60
        sessions.pause(interview)
        clock.now += 45 * 60
        paused = sessions.status(interview)
        sessions.resume(interview)
        clock.now += (interview.meta.get("change_at_minutes", 30) - 10) * 60 - 1
        before = sessions.status(interview)
        no_file = not (workspace / CHANGE_FILE).exists()
        clock.now += 1
        after = sessions.status(interview)
        c.check("change is hidden before its minute and while paused", paused["change"] is None and before["change"] is None and no_file, f"{before['elapsed'] / 60:.2f} min")
        c.check(f"change appears at minute {interview.meta.get('change_at_minutes', 30)} in the dashboard and CHANGE_REQUEST.md",
                after["change"] == interview.change_request() and (workspace / CHANGE_FILE).read_text(encoding="utf-8") == interview.change_request()
                and after["state"]["change_reveal_reason"] == "scheduled", f"revealed at {after['state']['change_revealed_at'] / 60:.1f} min")

        # 6. Reset restores the starter and deletes nothing.
        source = workspace / interview.meta["source_files"][-1]
        original = source.read_text(encoding="utf-8")
        source.write_text(original + "\n# candidate edit\n", encoding="utf-8")
        deleted = workspace / ("pytest.ini" if len(interview.meta["source_files"]) == 1 else interview.meta["source_files"][0])
        (workspace / "notes").mkdir(exist_ok=True)
        (workspace / "notes" / "mine.txt").write_text("keep me", encoding="utf-8")
        deleted.unlink()
        unrelated = home / "unrelated.txt"
        unrelated.write_text("outside the workspace", encoding="utf-8")
        report = reset_workspace(interview, home)
        fresh = scratch / "fresh"
        build_starter(interview, fresh, home)
        pristine = iter_files(fresh)
        now = iter_files(workspace)
        same = set(now) == set(pristine) and all(now[r].read_bytes() == pristine[r].read_bytes() for r in pristine)
        backup = Path(report["backup"])
        c.check("reset restores every starter file", same and source.read_text(encoding="utf-8") == original and deleted.exists())
        c.check("reset moves your changes and added files to a backup instead of deleting them",
                (backup / "notes" / "mine.txt").read_text(encoding="utf-8") == "keep me" and "# candidate edit" in (backup / interview.meta["source_files"][-1]).read_text(encoding="utf-8")
                and (backup / CHANGE_FILE).exists() and BACKUP_DIR in str(backup))
        c.check("reset leaves files outside the workspace alone", unrelated.read_text(encoding="utf-8") == "outside the workspace")
        unrelated.unlink()


def verify_problem(interview, home: Path, python: str, workspace: Path, scratch: Path, c: Checker) -> None:
    """A practice problem: the stub fails, the reference passes, and the coach has hints and an approach."""
    visible = run_pytest(python, workspace, ["tests"])
    starter = scratch / "starter"
    build_starter(interview, starter, home)
    hidden = _hidden_run(python, interview, starter)
    solved = scratch / "solved"
    build_starter(interview, solved, home)
    _overlay(interview.solution, solved)
    solved_hidden = _hidden_run(python, interview, solved)
    c.check("starter fails and the reference solution passes every test", visible["failed"] + visible["errors"] > 0 and hidden["passed"] == 0 and solved_hidden["ok"] and solved_hidden["total"] >= 6,
            f"reference {solved_hidden['passed']}/{solved_hidden['total']}")
    c.check("three hints, an approach, clarifications, and a speed test", len(interview.hints()) == 3 and interview.approach() and interview.clarifications()
            and any(info.get("area") == "performance" for info in interview.cases().values()))


def verify_problem_workflow(interview, home: Path, c: Checker) -> None:
    """One problem end to end, in real mode and then in coach mode."""
    from .server import Lab, make_server
    print(f"\nPractice problem workflow, real and coach modes [{interview.id}]")
    server = make_server(Lab(home, api_config=api.ApiConfig(env={})), port=0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        state = _http(port, "/api/start", {"interview": interview.id, "reset": True, "mode": "real"})
        c.check("starts in real mode", state["session"]["state"]["mode"] == "real")
        concept = _http(port, "/api/ask", {"interview": interview.id, "question": "What is a heap?"})["entry"]
        c.check("the real interviewer doesn't teach concepts", not concept["matched"])
        hint = _http(port, "/api/hint", {"interview": interview.id})["entry"]
        c.check("a real-mode hint is a nudge, not the whole answer", hint["answer"].startswith("Sure, here's a nudge") and interview.hints()[0] in hint["answer"])
        path = interview.meta["editor_files"][0]
        loaded = _http(port, f"/api/file?interview={interview.id}&path={path}")
        _http(port, "/api/file", {"interview": interview.id, "path": path, "content": (interview.solution / path).read_text(encoding="utf-8"), "mtime": loaded["mtime"]})
        real = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in real["scores"]}
        c.check("a solved real-mode problem scores correctness 5 and shows how to solve it", scores["correctness"] == 5 and real["mode"] == "real" and real["hints_used"] == 1 and real["approach"])
        c.check("problem rounds score their six areas", [s["area"] for s in real["scores"]] == [a for a, _ in grading.PROBLEM_AREAS])

        _http(port, "/api/start", {"interview": interview.id, "reset": True, "mode": "coach"})
        concept = _http(port, "/api/ask", {"interview": interview.id, "question": "What is a heap?"})["entry"]
        c.check("the coach explains concepts", concept["matched"] and "heap" in concept["answer"].lower())
        clarify = _http(port, "/api/ask", {"interview": interview.id, "question": f"Can there be {interview.clarifications()[1]['keywords'][0]}s?"})["entry"]
        c.check("the coach praises good clarifying questions", clarify["answer"].startswith("Good question"))
        hints = [_http(port, "/api/hint", {"interview": interview.id})["entry"]["answer"] for _ in range(4)]
        c.check("the coach gives all three hints in order, then offers the approach", all(h.startswith(f"Hint {i + 1} of 3") for i, h in enumerate(hints[:3])) and "Show the approach" in hints[3])
        run = _http(port, "/api/test", {"interview": interview.id})
        c.check("the coach reacts to failing tests", run["coach"] is not None and run["result"]["failed"] + run["result"]["errors"] > 0)
        approach = _http(port, "/api/approach", {"interview": interview.id})["entry"]
        c.check("the coach can show the approach", interview.approach()[:30] in approach["answer"])
        nudge = _http(port, "/api/nudge", {"interview": interview.id})["entry"]
        c.check("the coach checks in when you go quiet", nudge is not None and "hint" in nudge["answer"])
        state = _http(port, "/api/mode", {"interview": interview.id, "mode": "real"})
        c.check("you can switch modes mid-session", state["session"]["state"]["mode"] == "real" and state["session"]["state"]["mode_changes"])
        try:
            _http(port, "/api/approach", {"interview": interview.id})
            blocked = False
        except urllib.error.HTTPError:
            blocked = True
        c.check("the real interviewer won't show the approach", blocked)
        _http(port, "/api/mode", {"interview": interview.id, "mode": "coach"})
        coached = _http(port, "/api/submit", {"interview": interview.id})["report"]
        solving = next(s for s in coached["scores"] if s["area"] == "problem_solving")
        c.check("coach-mode reports note hints and cap the score after seeing the approach", coached["hints_used"] == 3 and (solving["score"] is None or solving["score"] <= 3) and "Coach mode" in coached["format_note"])
        listing = _http(port, "/api/interviews")
        tile = next(i for i in listing if i["id"] == interview.id)
        c.check("the lobby shows your last score and mode", tile["last_mode"] == "coach" and tile["last_score"] is not None and tile["format"] == "problem")
        verify_conversational_coach(interview, port, c)
    finally:
        server.shutdown()
        server.server_close()


def verify_conversational_coach(interview, port: int, c: Checker) -> None:
    """The Claude coach, against a stand-in for Roomside's Claude Code bridge (so it costs nothing and is repeatable)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from . import coach_ai
    seen = []

    class Bridge(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = json.dumps({"available": True, "loggedIn": True}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append((self.path, request))
            self.send_response(200 if self.path == "/api/claude-code" else 204)
            self.end_headers()
            if self.path == "/api/claude-code":
                for chunk in ("Good thinking. ", "What would that cost per call?"):
                    self.wfile.write((json.dumps({"text": chunk}) + "\n").encode())
                    self.wfile.flush()
                self.wfile.write(b'{"done": true}\n')

    bridge = ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    previous = os.environ.get("ROOMSIDE_URL")

    def coach(body):
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/coach", data=json.dumps({"interview": interview.id, **body}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return [json.loads(line) for line in response if line.strip()]

    try:
        os.environ["ROOMSIDE_URL"] = f"http://127.0.0.1:{bridge.server_address[1]}"
        coach_ai.status(force=True)
        state = _http(port, f"/api/state?interview={interview.id}")
        c.check("the page sees the conversational coach when Claude Code is signed in", state["coach_ai"]["available"])
        events = coach({"message": "Could I use a sorted list?"})
        text = "".join(e.get("text", "") for e in events)
        done = events[-1]
        c.check("coach replies stream from Claude and are recorded", text == "Good thinking. What would that cost per call?" and done.get("done") and done["entry"]["source"] == "coach-ai")
        prompt = next(r for path, r in seen if path == "/api/claude-code")
        c.check("the coach sees the problem, your code, and the conversation, with its own system prompt",
                "Candidate's current code" in prompt["prompt"] and "Could I use a sorted list?" in prompt["prompt"] and prompt["model"] == coach_ai.MODEL and "coach" in prompt["system"])
        hints_before = len(_http(port, f"/api/state?interview={interview.id}")["session"]["state"]["hints"])
        coach({"trigger": "hint"})
        hint_prompt = [r for path, r in seen if path == "/api/claude-code"][-1]["prompt"]
        hints_after = len(_http(port, f"/api/state?interview={interview.id}")["session"]["state"]["hints"])
        c.check("a Claude hint follows the hint ladder (and counts, while hints remain)", "asked for" in hint_prompt and hints_after >= hints_before)
        _http(port, "/api/mode", {"interview": interview.id, "mode": "real"})
        events = coach({"message": "Is a hash map the best approach?"})
        real_prompt = [r for path, r in seen if path == "/api/claude-code"][-1]
        c.check("real mode talks with Claude as a realistic interviewer, sharing the warm process", events[-1].get("done") and "You are the INTERVIEWER" in real_prompt["prompt"]
                and real_prompt["system"] == prompt["system"] and events[-1]["entry"]["mode"] == "real")
        _http(port, "/api/mode", {"interview": interview.id, "mode": "coach"})
        os.environ["ROOMSIDE_URL"] = "http://127.0.0.1:9"
        events = coach({"message": "How large can the input be?"})
        c.check("when Claude is unreachable, the scripted coach answers instead", "fallback" in events[-1] and events[-1]["entry"] and events[-1]["entry"]["answer"])
    finally:
        if previous is None:
            os.environ.pop("ROOMSIDE_URL", None)
        else:
            os.environ["ROOMSIDE_URL"] = previous
        coach_ai.status(force=True)
        bridge.shutdown()
        bridge.server_close()


def verify_behavioral_round(interview, home: Path, workspace: Path, scratch: Path, c: Checker) -> None:
    from .catalog import leadership_bank
    c.check("no-AI round: the workspace tells the assistant not to help", "Do not help with the exercise" in (workspace / "CLAUDE.md").read_text(encoding="utf-8"))
    bank = {entry["lp"]: entry for entry in leadership_bank()}
    c.check("the bank covers all 16 Leadership Principles with two questions and three follow-ups each",
            len(bank) == 16 and all(len(e["questions"]) == 2 and all(len(q["followups"]) == 3 for q in e["questions"]) for e in bank.values()))
    rotation_home = scratch / "rotation"  # a fresh history, so earlier checks' questions don't count
    rotation_home.mkdir()
    sessions = Sessions(rotation_home, clock=FakeClock())
    seen, plans = set(), []
    for _ in range(8):
        sessions.start(interview, reset=True)
        plan = sessions.load(interview.id)["behavioral"]["plan"]
        plans.append(plan)
        seen.update(item["id"] for item in plan)
    count = interview.meta["behavioral"]["count"]
    c.check(f"each session asks {count} different principles", all(len({item['lp'] for item in plan}) == count for plan in plans))
    c.check("repeat sessions rotate through the whole bank before repeating", len(seen) == 32, f"{len(seen)} of 32 questions in 8 sessions")
    sessions = Sessions(home, clock=FakeClock())
    sessions.start(interview, reset=True)
    status = sessions.status(interview)
    c.check("a behavioral round has no requirement change", status["change_at"] is None and status["change"] is None)
    readme = workspace / "README.md"
    readme.write_text(readme.read_text(encoding="utf-8") + "\nmy notes\n", encoding="utf-8")
    (workspace / "stories.txt").write_text("keep me", encoding="utf-8")
    report = reset_workspace(interview, home)
    backup = Path(report["backup"])
    c.check("reset restores the starter and backs up your files", "my notes" not in readme.read_text(encoding="utf-8") and (backup / "stories.txt").read_text(encoding="utf-8") == "keep me")


def verify_behavioral_workflow(interview, home: Path, c: Checker) -> None:
    from .server import Lab, make_server
    print(f"\nDashboard workflow without an API key [{interview.id}]")
    server = make_server(Lab(home, api_config=api.ApiConfig(env={})), port=0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        _http(port, "/api/start", {"interview": interview.id, "reset": True})
        empty = {s["area"]: s["score"] for s in _http(port, "/api/submit", {"interview": interview.id})["report"]["scores"]}
        c.check("every area is 'not observed' before you answer", all(v is None for v in empty.values()))
        _http(port, "/api/start", {"interview": interview.id, "reset": True})
        plan = _http(port, f"/api/state?interview={interview.id}")["session"]["state"]["behavioral"]["plan"]
        story = ("Last spring during my internship I was responsible for our signup page. I noticed users complained it was slow, so I decided to dig in. "
                 "I measured load times, I found two blocking scripts, I rewrote the loader and I tested it on slow phones. As a result load time dropped 60% "
                 "and signups rose 15%. Looking back, I learned to measure before guessing, and next time I'd set up monitoring first.")
        prompts = []
        while True:
            entry = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            if entry is None:
                break
            prompts.append(entry["answer"])
            _http(port, "/api/answer", {"interview": interview.id, "text": story})
        expected = [p for item in plan for p in [item["question"], *item["followups"]]]
        c.check("the interviewer asks every planned question and follow-up in order", prompts == expected, f"{len(prompts)} prompts")
        _http(port, "/api/ask", {"interview": interview.id, "question": "What does a typical day look like for interns on your team?"})
        report = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in report["scores"]}
        c.check("all six behavioral areas are scored", [x["area"] for x in report["scores"]] == [a for a, _ in grading.BEHAVIORAL_AREAS] and all(v is not None for v in scores.values()), str(scores))
        c.check("the report breaks the score down by principle", [row["lp"] for row in report["lp_breakdown"]] == [item["lp"] for item in plan])
        c.check("a strong, owned, measured story scores well", scores["impact"] >= 4 and scores["star"] >= 4, f"impact {scores['impact']}, STAR {scores['star']}")
        c.check("reusing one story for every principle is marked down", all(row["score"] <= 3 for row in report["lp_breakdown"][1:]) and scores["leadership"] <= 3, f"Leadership {scores['leadership']}")
        prompt = _http(port, f"/api/packet?interview={interview.id}&kind=interviewer")["text"]
        c.check("the interviewer prompt includes the principles bank", "Customer Obsession" in prompt and "Follow-ups" in prompt)
    finally:
        server.shutdown()
        server.server_close()


def verify_workflow(interview, home: Path, c: Checker) -> None:
    if interview.meta.get("format") == "amazon-behavioral":
        return verify_behavioral_workflow(interview, home, c)
    if interview.meta.get("format") == "problem":
        if interview.id == "two-sum":  # one problem end to end; the others share the same machinery
            verify_problem_workflow(interview, home, c)
        return
    """The whole session through the dashboard's HTTP API, with API mode off and no key."""
    from .server import Lab, make_server
    print(f"\nDashboard workflow without an API key [{interview.id}]")
    config = api.ApiConfig(env={})
    server = make_server(Lab(home, api_config=config), port=0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        state = _http(port, "/api/start", {"interview": interview.id, "reset": True})
        c.check("dashboard starts a session with API mode off", state["session"]["started"] and not state["api"]["enabled"] and not state["api"]["has_key"])
        first_topic = next(e for e in interview.clarifications() if e.get("important"))
        entry = _http(port, "/api/ask", {"interview": interview.id, "question": f"Quick question about {first_topic['keywords'][0]} and {first_topic['keywords'][1]}?"})["entry"]
        c.check("offline interviewer answers a clarification", entry["matched"] and entry["topic"] == first_topic["topic"], entry["topic"] or "no match")
        _http(port, "/api/note", {"interview": interview.id, "field": "plan", "text": f"Read {', '.join(interview.meta['source_files'][:3])} and traced the main path before changing anything."})
        _http(port, "/api/note", {"interview": interview.id, "field": "explanation", "text": "I fixed the reported bugs because the tests showed them, and added regression tests. Tradeoff: kept the change small instead of refactoring."})
        runnable = interview.meta.get("run_tests_allowed", True)
        if runnable:
            before = _http(port, "/api/test", {"interview": interview.id})["result"]
            c.check("visible tests run from the dashboard and show the starter failures", before["failed"] > 0)
        else:
            try:
                _http(port, "/api/test", {"interview": interview.id})
                refused = False
            except urllib.error.HTTPError as error:
                refused = error.code == 400
            c.check("no-run round: the dashboard refuses to run tests", refused)

        starter_report = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in starter_report["scores"]}
        c.check("submitting the untouched starter scores correctness low", scores["correctness"] <= 2 and starter_report["missed_cases"], f"correctness {scores['correctness']}")
        amazon = interview.meta.get("format") == "amazon-final"
        if amazon:
            c.check("Leadership Principles are 'not observed' before any answer", scores["leadership"] is None and "ai_instructions" not in scores)
            plan = _http(port, f"/api/state?interview={interview.id}")["session"]["state"]["behavioral"]["plan"]
            c.check("this session's principles come from the round's focus list", len(plan) == 2 and all(item["lp"] in interview.meta["behavioral"]["focus"] for item in plan))
            first = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            _http(port, "/api/answer", {"interview": interview.id, "text": "During my internship last summer I noticed our deploy script had no owner, so I decided to fix it. I rewrote it, tested it, and documented it. As a result deploys dropped from 40 minutes to 8 minutes. I learned to ask who owns something early."})
            follow = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            waiting = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            c.check("the interviewer asks an LP question, digs in with a follow-up, then waits for an answer",
                    first["answer"] == plan[0]["question"] and follow["answer"] == plan[0]["followups"][0] and waiting is None)

        workspace = workspace_path(interview, home)
        if interview.meta.get("editor_files"):
            path = interview.meta["editor_files"][0]
            loaded = _http(port, f"/api/file?interview={interview.id}&path={path}")
            solution = (interview.solution / path).read_text(encoding="utf-8")
            saved = _http(port, "/api/file", {"interview": interview.id, "path": path, "content": solution, "mtime": loaded["mtime"]})
            c.check("the browser editor loads and saves the workspace file", saved.get("saved") and (workspace / path).read_text(encoding="utf-8") == solution)
            try:
                _http(port, "/api/file", {"interview": interview.id, "path": path, "content": "stale", "mtime": loaded["mtime"]})
                conflict = False
            except urllib.error.HTTPError as error:
                conflict = error.code == 409
            c.check("an edit made elsewhere is not silently overwritten", conflict and (workspace / path).read_text(encoding="utf-8") == solution)
            try:
                _http(port, f"/api/file?interview={interview.id}&path=../../etc/passwd")
                escaped = True
            except urllib.error.HTTPError:
                escaped = False
            c.check("the browser editor can't open files outside the round's editor files", not escaped)
            run = _http(port, "/api/run", {"interview": interview.id, "code": interview.meta["custom_input"]})
            c.check("custom input runs against your code", run["ok"] and run["stdout"].strip() != "", run["stdout"].strip()[:60])
            looping = _http(port, "/api/run", {"interview": interview.id, "code": "while True:\n    pass\n"})
            c.check("an infinite loop in custom input is stopped", looping["timed_out"])
        _overlay(interview.solution, workspace)  # stands in for the candidate's work
        (workspace / "tests" / "test_regressions.py").write_text(CANDIDATE_TESTS[interview.id], encoding="utf-8")
        _http(port, "/api/reveal", {"interview": interview.id})
        if runnable:
            after = _http(port, "/api/test", {"interview": interview.id})["result"]
            c.check("visible tests pass after the fix", after["ok"], f"{after['passed']} passed")
        report = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in report["scores"]}
        expected_areas = [area for area, _ in grading.areas_for(interview)]
        c.check(f"report scores all {len(expected_areas)} areas for this format", [x["area"] for x in report["scores"]] == expected_areas)
        c.check("fixed workspace passes every grading test", report["tests"]["grading"]["failed"] + report["tests"]["grading"]["errors"] == 0 and scores["correctness"] == 5)
        c.check("a regression test that fails on the starter is credited", report["tests"]["your_tests_that_catch_starter_bugs"] >= 1)
        if amazon:
            evidence = next(x["evidence"] for x in report["scores"] if x["area"] == "leadership")
            c.check("Leadership Principles answers are scored with evidence", scores["leadership"] is not None and any("words" in line for line in evidence), f"{scores['leadership']}/5")
            c.check("the report says this was a no-AI round", bool(report.get("format_note")) and report.get("patch_review") is None)
        else:
            c.check("areas without evidence are 'not observed'", scores["ai_instructions"] is None)
        c.check("report lists three improvements and a follow-up exercise", len(report["improvements"]) == 3 and report["follow_up"]["exercise"])
        grading_prompt = _http(port, f"/api/packet?interview={interview.id}&kind=grading")["text"]
        interviewer_prompt = _http(port, f"/api/packet?interview={interview.id}&kind=interviewer")["text"]
        c.check("copyable grading and interviewer prompts are produced", "not observed" in grading_prompt and interview.change_request()[:40] in interviewer_prompt)
        if amazon:
            c.check("the grading prompt includes the Leadership Principles answers", "deploy script" in grading_prompt)
        feedback = _http(port, "/api/feedback", {"interview": interview.id})
        c.check("API feedback degrades gracefully with API mode off", feedback.get("api_error", {}).get("kind") == "off")
    finally:
        server.shutdown()
        server.server_close()


def run() -> int:
    python = test_python(practice_home())
    probe = subprocess.run([python, "-m", "pytest", "--version"], capture_output=True, text=True)
    if probe.returncode:
        print(f"pytest is not available for {python}. Run: python3 practice/lab.py setup")
        return 1
    c = Checker()
    saved = {key: os.environ.get(key) for key in ("PRACTICE_HOME", "PRACTICE_PYTHON", "ANTHROPIC_API_KEY", "PRACTICE_API_MODE", "ROOMSIDE_URL")}
    with tempfile.TemporaryDirectory() as scratch:
        home = Path(scratch) / "home"
        home.mkdir()
        os.environ["PRACTICE_HOME"] = str(home)
        os.environ["PRACTICE_PYTHON"] = python
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ["ROOMSIDE_URL"] = "http://127.0.0.1:9"  # verify never calls your real Claude Code
        os.environ.pop("PRACTICE_API_MODE", None)
        try:
            print(f"Verifying in a temporary PRACTICE_HOME with {probe.stdout.strip()}")
            for interview in all_interviews():
                verify_interview(interview, home, python, c)
            for interview in all_interviews():
                verify_workflow(interview, home, c)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    print()
    if c.failures:
        print(f"{len(c.failures)} check(s) failed:")
        for failure in c.failures:
            print(f"  - {failure}")
        return 1
    print("All checks passed.")
    return 0
