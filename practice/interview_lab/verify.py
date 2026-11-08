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
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, List

from . import api, grading, interviewer
from .catalog import LAB_COMMAND, LAB_ROOT, all_interviews, claude_rule_path, practice_home, test_python
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
    "amazon-full-loop": '''from deliveries.late_carriers import top_late_carriers


def test_tie_is_alphabetical():
    assert top_late_carriers([("a", "Zed", 1, 2), ("b", "Amy", 1, 2)], 2) == ["Amy", "Zed"]
''',
    "amazon-final-2": '''from fulfillment.robot_moves import min_moves


def test_unreachable():
    assert min_moves(["D#P"]) == -1
''',
    "amazon-coding": '''from pricing.price_alerts import days_until_cheaper


def test_the_same_price_is_not_cheaper():
    assert days_until_cheaper([5, 5, 4]) == [2, 1, 0]
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


# Versions of the coding round's solution a candidate might write first: right, but quadratic (each day looks ahead;
# each add scans every waiting day), and one that's wrong (equal prices count as cheaper).
SLOW_MAIN = '''def days_until_cheaper(prices):
    waits = []
    for day, price in enumerate(prices):
        later = next((other for other in range(day + 1, len(prices)) if prices[other] < price), None)
        waits.append(0 if later is None else later - day)
    return waits
'''
SLOW_FOLLOWUP = '''

class PriceWatch:
    def __init__(self):
        self.waiting, self.today = [], 0

    def add(self, price):
        resolved = [(day, self.today - day) for day, old in self.waiting if old > price]
        self.waiting = [(day, old) for day, old in self.waiting if old <= price] + [(self.today, price)]
        self.today += 1
        return resolved
'''
WRONG_MAIN = SLOW_MAIN.replace("prices[other] < price", "prices[other] <= price")


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
        settings = json.loads((workspace / ".claude" / "settings.json").read_text(encoding="utf-8"))
        c.check("CLAUDE.md and assistant deny rules are in place", (workspace / "CLAUDE.md").exists() and any(claude_rule_path(LAB_ROOT) in rule for rule in settings["permissions"]["deny"]))

        if interview.meta.get("format") == "amazon-behavioral":
            verify_behavioral_round(interview, home, workspace, scratch, c)
            return
        if interview.meta.get("format") == "resume":
            verify_resume_round(interview, home, workspace, scratch, c)
            return
        if interview.meta.get("format") == "problem":
            verify_problem(interview, home, python, workspace, scratch, c)
            return
        if interview.meta.get("format") == "palantir-learning":
            verify_learning_round(interview, home, python, workspace, scratch, c)
            return

        # 2. Starter defects are detectable.
        visible = run_pytest(python, workspace, ["tests"])
        blank = interview.meta.get("format") in ("amazon-final", "amazon-coding")  # an empty function to write, not planted bugs
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
        applied = subprocess.run(["git", "apply", "patch_review/ai_patch.diff"], cwd=patched, capture_output=True, encoding="utf-8", errors="replace") if has_patch else None
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
        c.check("change is hidden before its minute and while paused", paused["change"] is None and before["change"] is None and no_file, f"{before['elapsed'] / 60:.2f} min")
        if interview.meta.get("format") == "amazon-coding":
            # The coding round's follow-up waits for a solution that works, and comes once it's fast.
            c.check("the follow-up waits for a working solution, even past its minute", sessions.status(interview)["change"] is None)
            sessions.assess(interview, {"status": "fast", "seconds": 0.01})
            after = sessions.status(interview)
            examples = sorted(p.name for p in interview.followup_tests.glob("test_*.py"))
            c.check("a fast solution brings the follow-up, its CHANGE_REQUEST.md, and its example tests",
                    after["change"] == interview.change_request() and (workspace / CHANGE_FILE).read_text(encoding="utf-8") == interview.change_request()
                    and after["state"]["change_reveal_reason"] == "solved" and bool(examples) and all((workspace / "tests" / name).exists() for name in examples))
        else:
            after = sessions.status(interview)
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
        first = _http(port, "/api/hint", {"interview": interview.id})["entry"]["answer"]
        again = _http(port, "/api/hint", {"interview": interview.id})["entry"]["answer"]
        used = len(_http(port, f"/api/state?interview={interview.id}")["session"]["state"]["hints"])
        c.check("asking for a hint again without doing anything rephrases it instead of moving on", first.startswith("Hint 1 of 3") and again.startswith("Let's stay with the last hint") and used == 1)
        hints = [first]
        for attempt in range(3):
            _http(port, "/api/speech", {"interview": interview.id, "text": f"okay so my idea number {attempt} is to try something different here"})
            hints.append(_http(port, "/api/hint", {"interview": interview.id})["entry"]["answer"])
        c.check("after some progress, the coach gives the next hint, then offers the approach", hints[1].startswith("Hint 2 of 3") and hints[2].startswith("Hint 3 of 3") and "Show the approach" in hints[3])
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


SAMPLE_ANSWERS = {
    "walkthrough": "I'm currently a junior at State University studying computer science. Most recently I interned at Brightline Logistics on the tracking team, "
                   "where I built a Python service that batches shipment updates. Before that I built StudySync, a React and Node app for study groups, and I'm a TA "
                   "for data structures. I'm looking for an internship where I can work on backend systems at scale, ideally around reliability and performance.",
    "depth": "I built the batching service myself. The problem was that we called carrier APIs once per shipment, which hit rate limits. I chose to queue updates "
             "in Redis and flush them every thirty seconds instead of calling per event, because the carriers accept bulk requests; the tradeoff was a little latency. "
             "I wrote integration tests with pytest. The hardest bug was a race condition when two workers flushed the same batch; I traced it in the logs and added a lock. "
             "As a result API calls dropped 40%.",
    "teamwork": "During my internship I disagreed with a teammate about caching the tracking page. My role was the backend, and the goal was faster loads. I measured p95 "
                "latency, I wrote a short doc comparing options, and I proposed a TTL cache. We tried it and latency fell from 900 ms to 250 ms. Looking back, I learned "
                "to bring data to a disagreement instead of opinions.",
}


def verify_resume_round(interview, home: Path, workspace: Path, scratch: Path, c: Checker) -> None:
    from . import coach_ai, resume
    sample = (interview.interviewer / "sample_resume.md").read_text(encoding="utf-8")
    c.check("no-AI round: the workspace tells the assistant not to help", "Do not help with the exercise" in (workspace / "CLAUDE.md").read_text(encoding="utf-8"))
    bare = scratch / "no-resume"
    bare.mkdir()
    generic = Sessions(bare, clock=FakeClock())
    generic.start(interview, reset=True)
    c.check("without a résumé, the scripted interviewer asks general questions", "proudest of" in generic.load(interview.id)["behavioral"]["plan"][1]["question"])
    saved = resume.save(home, "sample_resume.md", sample)
    summary = resume.summary(resume.load(home))
    c.check("your résumé is saved on this computer, and its roles and projects are found",
            saved["text"].startswith("Jordan Lee") and "StudySync" in summary["items"] and any("Brightline Logistics" in item for item in summary["items"]), ", ".join(summary["items"]))
    sessions = Sessions(home, clock=FakeClock())
    sessions.start(interview, reset=True)
    plan = sessions.load(interview.id)["behavioral"]["plan"]
    c.check("the scripted interviewer goes deep on things from your résumé", "Brightline Logistics" in plan[1]["question"] and "StudySync" in plan[2]["question"], plan[1]["question"])
    status = sessions.status(interview)
    c.check("a 30-minute conversation with no requirement change", status["change_at"] is None and interview.meta["duration_minutes"] == 30)
    state = sessions.load(interview.id)
    opening = coach_ai.build_resume_prompt(interview, state, sample, 20, "open")
    c.check("Claude's interviewer gets your résumé, the plan, and its role", "StudySync" in opening and "SENIOR SOFTWARE ENGINEER" in opening and "Deep dive: a second experience" in opening and "walk you through their background" in opening)
    turn = coach_ai.build_resume_prompt(interview, state, sample, 11.6 * 60, "message", "We used Redis for the queue.")
    c.check("it keeps time: near the end of a part it moves to the next one", 'move to "Deep dive: a second experience" now' in turn and "We used Redis for the queue." in turn)
    c.check("and closes when time is up", "Time's up" in coach_ai.build_resume_prompt(interview, state, sample, 31 * 60, "message", "Thanks!"))
    asked = coach_ai.principles(state)
    focus = interview.meta["behavioral"]["focus"]
    c.check("each session asks two different Leadership Principles from the intern-relevant ones", len({item["lp"] for item in asked}) == 2 and all(item["lp"] in focus for item in asked), ", ".join(item["lp"] for item in asked))
    c.check("they come after the deep dives, in their own section", plan[3].get("section") == "Leadership Principles" and plan[3]["question"].startswith("Let's switch gears") and plan[4].get("lp") and "questions do you have" in plan[5]["question"])
    opening = coach_ai.build_resume_prompt(interview, state, sample, 18.4 * 60, "message", "That's how StudySync matched schedules.", start_section=True)
    first = asked[0]["question"].replace(resume.LP_INTRO, "")
    c.check("Claude opens the section out loud: a transition, then the first principles question", "Now start the Leadership Principles section" in opening and first in opening and "up to three" in opening)
    during = coach_ai.build_resume_prompt(interview, state, sample, 22 * 60, "message", "I owned the migration.")
    c.check("during the section, Claude has both questions, their follow-ups, and what to listen for", all(item["lp"] in during and item["followups"][0] in during for item in asked) and "Spend about half the section" in during)
    c.check("one system prompt serves the coach, the interviewer, and the résumé interviewer (so the warm process is reused)", "résumé" in coach_ai.SYSTEM and "coding interview" in coach_ai.SYSTEM)


def verify_resume_workflow(interview, home: Path, c: Checker) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from . import coach_ai
    from .server import Lab, make_server
    print(f"\nDashboard workflow without an API key [{interview.id}]")
    lab = Lab(home, api_config=api.ApiConfig(env={}))
    server = make_server(lab, port=0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    sample = (interview.interviewer / "sample_resume.md").read_text(encoding="utf-8")

    def stream(path, body):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps({"interview": interview.id, **body}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return [json.loads(line) for line in response if line.strip()]

    try:
        saved = _http(port, "/api/my-resume", {"interview": interview.id, "name": "sample_resume.md", "text": sample})["resume"]
        c.check("the dashboard saves the résumé you add", saved["name"] == "sample_resume.md" and saved["chars"] > 500)
        c.check("and gives it back for editing", _http(port, f"/api/my-resume?interview={interview.id}")["resume"]["text"].startswith("Jordan Lee"))
        state = _http(port, "/api/start", {"interview": interview.id, "reset": True})
        c.check("the page knows which résumé the interview uses", state["resume"]["name"] == "sample_resume.md")
        empty = {s["area"]: s["score"] for s in _http(port, "/api/submit", {"interview": interview.id})["report"]["scores"]}
        c.check("every area is 'not observed' before you answer", all(v is None for v in empty.values()))

        # Without Claude (Roomside isn't running in verify), the scripted interviewer runs the conversation.
        _http(port, "/api/start", {"interview": interview.id, "reset": True})
        plan = _http(port, f"/api/state?interview={interview.id}")["session"]["state"]["behavioral"]["plan"]
        principle_prompts = {p for item in plan if item.get("lp") for p in [item["question"], *item["followups"]]}
        _http(port, "/api/cue", {"interview": interview.id, "cue": "rs_intro"})
        opened = stream("/api/coach", {"trigger": "open"})[-1]
        c.check("when Claude isn't available, the scripted interviewer opens with the walkthrough", "fallback" in opened and "walk me through your background" in opened["entry"]["answer"])
        prompts = [opened["entry"]["answer"]]
        for i in range(30):
            prompt = prompts[-1]
            if "What questions do you have" in prompt:
                break
            answer = SAMPLE_ANSWERS["walkthrough"] if i == 0 else SAMPLE_ANSWERS["teamwork"] if prompt in principle_prompts else SAMPLE_ANSWERS["depth"] + f" Detail {i}: I also profiled one endpoint and cut its queries from {i + 5} to 1."
            entry = stream("/api/coach", {"message": answer, "voice": True})[-1]["entry"]
            if entry is None:
                break
            prompts.append(entry["answer"])
        c.check("it asks about your résumé, then the Leadership Principles section, then takes your questions",
                any("Brightline" in p for p in prompts) and any(p.startswith("Let's switch gears") for p in prompts) and "What questions do you have" in prompts[-1], f"{len(prompts)} prompts")
        entries = _http(port, f"/api/state?interview={interview.id}")["session"]["state"]["questions"]
        c.check("the section's first question is marked, so the page shows where it starts", [e.get("section") for e in entries if e.get("section")] == ["Leadership Principles"])
        asked = stream("/api/coach", {"message": "What does a typical day look like for you?"})[-1]["entry"]
        c.check("your questions at the end get an answer", "code reviews" in asked["answer"])
        report = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in report["scores"]}
        c.check("all six résumé areas are scored", [x["area"] for x in report["scores"]] == [a for a, _ in grading.RESUME_AREAS] and all(v is not None for v in scores.values()), str(scores))
        c.check("specific, owned, measured answers score well on depth and ownership", scores["depth"] >= 4 and scores["ownership"] >= 4, str(scores))
        c.check("the report is a conversation report (no tests)", report["behavioral_only"] and "résumé" in report["format_note"])
        c.check("and breaks the Leadership Principles down story by story", [row["lp"] for row in report["lp_breakdown"]] == [item["lp"] for item in plan if item.get("lp")]
                and not report["lp_breakdown"][0]["question"].startswith("Let's switch gears"), str([row["lp"] for row in report["lp_breakdown"]]))
        failed = stream("/api/debrief", {})
        c.check("without Claude, the interviewer's notes explain what's missing", "error" in failed[-1])

        # With Claude: a stand-in for Roomside's bridge, so it's free and repeatable.
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
                    reply = "## Overall\nSolid." if "interview notes" in request["system"] else "Got it. What did you build yourself on StudySync?"
                    self.wfile.write((json.dumps({"text": reply}) + "\n").encode() + b'{"done": true}\n')

        bridge = ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
        threading.Thread(target=bridge.serve_forever, daemon=True).start()
        previous = os.environ.get("ROOMSIDE_URL")
        try:
            os.environ["ROOMSIDE_URL"] = f"http://127.0.0.1:{bridge.server_address[1]}"
            coach_ai.status(force=True)
            _http(port, "/api/start", {"interview": interview.id, "reset": True})
            c.check("the page sees Claude's interviewer when Claude Code is signed in", _http(port, f"/api/state?interview={interview.id}")["coach_ai"]["available"])
            events = stream("/api/coach", {"message": SAMPLE_ANSWERS["walkthrough"], "voice": True})
            c.check("Claude's replies stream in and the turn is recorded", events[-1].get("done") and events[-1]["entry"]["question"].startswith("I'm currently a junior") and events[-1]["entry"]["voice"])
            prompt = next(r for path, r in seen if path == "/api/claude-code")
            c.check("the interviewer sees your résumé and what you just said, on the shared warm system prompt",
                    "StudySync" in prompt["prompt"] and "I'm currently a junior" in prompt["prompt"] and prompt["system"] == coach_ai.SYSTEM and "warm" not in prompt)
            stream("/api/coach", {"message": "I built the batching service myself."})
            second = [r for path, r in seen if path == "/api/claude-code"][-1]["prompt"]
            c.check("the conversation so far labels who said what", "Candidate: I'm currently a junior" in second and "Interviewer: Got it. What did you build yourself on StudySync?" in second)
            # 18.5 minutes in: your next answer opens the Leadership Principles section.
            state = lab.sessions.load(interview.id)
            state["started_at"] -= 18.5 * 60
            lab.sessions.save(state)
            events = stream("/api/coach", {"message": "That's how the matching worked.", "voice": True})
            sent = [r for path, r in seen if path == "/api/claude-code"][-1]["prompt"]
            c.check("when its time comes, your next answer opens the Leadership Principles section", events[0].get("section") == "Leadership Principles"
                    and events[-1]["entry"].get("section") == "Leadership Principles" and "Now start the Leadership Principles section" in sent)
            again = stream("/api/coach", {"message": "During my internship I owned the migration."})
            c.check("and it opens only once", not any(e.get("section") for e in again) and not again[-1]["entry"].get("section"))
            _http(port, "/api/submit", {"interview": interview.id})
            notes = stream("/api/debrief", {})
            report = _http(port, f"/api/report?interview={interview.id}")["report"]
            debrief = [r for path, r in seen if path == "/api/claude-code" and "interview notes" in r["system"]]
            c.check("after you submit, the interviewer writes notes, saved with the report",
                    notes[-1].get("done") and report["interviewer_notes"].startswith("## Overall") and Path(report["saved_to"], "interviewer_notes.md").exists())
            c.check("the notes see the transcript and your résumé, in a one-off process", debrief and "Transcript" in debrief[0]["prompt"] and "StudySync" in debrief[0]["prompt"] and debrief[0].get("warm") is False)
        finally:
            if previous is None:
                os.environ.pop("ROOMSIDE_URL", None)
            else:
                os.environ["ROOMSIDE_URL"] = previous
            coach_ai.status(force=True)
            bridge.shutdown()
            bridge.server_close()
    finally:
        server.shutdown()
        server.server_close()


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
        verify_behavioral_claude(interview, port, story, c)
    finally:
        server.shutdown()
        server.server_close()


def verify_behavioral_claude(interview, port: int, story: str, c: Checker) -> None:
    """Claude words the behavioral interviewer's prompts, against a stand-in for Roomside's bridge (free and repeatable)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from . import coach_ai
    reply = "Okay, the signup page. What did you change first?"
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
                self.wfile.write((json.dumps({"text": reply}) + "\n").encode() + b'{"done": true}\n')

    def stream(body):
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/behavioral", data=json.dumps({"interview": interview.id, **body}).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return [json.loads(line) for line in response if line.strip()]

    bridge = ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    previous = os.environ.get("ROOMSIDE_URL")
    try:
        os.environ["ROOMSIDE_URL"] = f"http://127.0.0.1:{bridge.server_address[1]}"
        coach_ai.status(force=True)
        _http(port, "/api/start", {"interview": interview.id, "reset": True})
        _http(port, "/api/my-resume", {"interview": interview.id, "name": "resume.md", "text": "Jordan Lee\nSoftware Engineering Intern, Northwind Labs (Summer 2025)\n- Rebuilt the signup loader"})
        state = _http(port, f"/api/state?interview={interview.id}")
        c.check("the behavioral round sees Claude and your résumé", state["coach_ai"]["available"] and state["resume"]["name"] == "resume.md")
        _http(port, "/api/answer", {"interview": interview.id, "text": "Hi, I'm Jordan, a junior studying computer science, and last summer I interned at Northwind Labs."})
        events = stream({"claude": True, "cue": "amz_behavioral"})
        sent = [r for path, r in seen if path == "/api/claude-code"][-1]
        after = _http(port, f"/api/state?interview={interview.id}")["session"]["state"]
        first = after["behavioral"]["plan"][0]
        c.check("finish your introduction early and Claude picks up on it, then asks the first question in its own words",
                events[-1].get("done") and events[-1]["entry"]["answer"] == reply and "amz_behavioral" in after["cues"] and "finished introducing themselves" in sent["prompt"]
                and first["question"] in sent["prompt"] and "Northwind Labs (Summer 2025)" in sent["prompt"] and sent["system"] == coach_ai.SYSTEM)
        c.check("and the minute-2 line isn't said on top of it", _http(port, "/api/cue", {"interview": interview.id, "cue": "amz_behavioral"})["entry"] is None)
        _http(port, "/api/answer", {"interview": interview.id, "text": story})
        events = stream({"claude": True})
        sent = [r for path, r in seen if path == "/api/claude-code"][-1]["prompt"]
        c.check("each follow-up is the plan's, asked by Claude about your story",
                events[-1]["entry"]["kind"] == "behavioral:followup" and f'The planned one is: "{first["followups"][0]}"' in sent and "blocking scripts" in sent)
        os.environ["ROOMSIDE_URL"] = "http://127.0.0.1:9"
        _http(port, "/api/answer", {"interview": interview.id, "text": story})
        events = stream({"claude": True})
        c.check("when Claude is unreachable, the scripted follow-up comes instead", "fallback" in events[-1] and events[-1]["entry"]["answer"] == first["followups"][1])
        flow = _http(port, f"/api/state?interview={interview.id}")["session"]["state"]["behavioral"]
        c.check("grading sees every prompt in the words it was asked", flow["answers"][0]["prompts"] == [reply, reply, first["followups"][1]])
    finally:
        if previous is None:
            os.environ.pop("ROOMSIDE_URL", None)
        else:
            os.environ["ROOMSIDE_URL"] = previous
        coach_ai.status(force=True)
        bridge.shutdown()
        bridge.server_close()


def verify_workflow(interview, home: Path, c: Checker) -> None:
    if interview.meta.get("format") == "amazon-behavioral":
        return verify_behavioral_workflow(interview, home, c)
    if interview.meta.get("format") == "amazon-coding":
        return verify_coding_round_workflow(interview, home, c)
    if interview.meta.get("format") == "palantir-learning":
        return verify_learning_workflow(interview, home, c)
    if interview.meta.get("format") == "resume":
        return verify_resume_workflow(interview, home, c)
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
            deep_dive = grading.resume_deep_dive(interview)
            principles = [item for item in plan if item.get("lp")]
            c.check("this session's principles come from the round's focus list", len(principles) == 2 and all(item["lp"] in interview.meta["behavioral"]["focus"] for item in principles))
            if deep_dive:
                c.check("the full interview opens with one résumé deep dive, then the principles", [item["kind"] for item in plan] == ["depth", "leadership", "leadership"])
            story = "During my internship last summer I noticed our deploy script had no owner, so I decided to fix it. I rewrote it, tested it, and documented it. As a result deploys dropped from 40 minutes to 8 minutes. I learned to ask who owns something early."
            first = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            _http(port, "/api/answer", {"interview": interview.id, "text": story})
            follow = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            waiting = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
            c.check("the interviewer asks its first question, digs in with a follow-up, then waits for an answer",
                    first["answer"] == plan[0]["question"] and follow["answer"] == plan[0]["followups"][0] and waiting is None)
            if deep_dive:  # finish the deep dive, then answer the first principles question, so both are scored below
                while True:
                    _http(port, "/api/answer", {"interview": interview.id, "text": "I built the sync service myself because polling was too slow, so I chose websockets instead. The hardest bug was a race condition I traced in the logs."})
                    entry = _http(port, "/api/behavioral", {"interview": interview.id})["entry"]
                    if entry is None or entry["kind"] == "behavioral:question":
                        break
                _http(port, "/api/answer", {"interview": interview.id, "text": story})

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
            if deep_dive:
                depth = next(x["evidence"] for x in report["scores"] if x["area"] == "depth")
                c.check("the résumé deep dive is scored as technical depth, apart from the principles", scores["depth"] is not None and "websockets" in depth[1]
                        and all("websockets" not in line for line in evidence), f"{scores['depth']}/5")
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
        if amazon:
            verify_amazon_clock(interview, port, c)
    finally:
        server.shutdown()
        server.server_close()


def verify_coding_round_workflow(interview, home: Path, c: Checker) -> None:
    """The coding round through the dashboard, with the scripted interviewer: it asks for a faster version of a slow
    solution, helps when you're stuck, gives the follow-up once it's fast, and the report says how much help you needed."""
    from .server import Lab, make_server
    print(f"\nCoding round workflow without Claude [{interview.id}]")
    clock = FakeClock()
    server = make_server(Lab(home, sessions=Sessions(home, clock=clock), api_config=api.ApiConfig(env={})), port=0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    iid, path = interview.id, interview.meta["editor_files"][0]
    workspace = workspace_path(interview, home)
    state = lambda: _http(port, f"/api/state?interview={iid}")["session"]
    stuck = lambda: _http(port, f"/api/stuck?interview={iid}")["help"]

    def write(code: str) -> None:
        loaded = _http(port, f"/api/file?interview={iid}&path={path}")
        _http(port, "/api/file", {"interview": iid, "path": path, "content": code, "mtime": loaded["mtime"]})

    try:
        _http(port, "/api/start", {"interview": iid, "reset": True})
        intro = _http(port, "/api/cue", {"interview": iid, "cue": "ac_intro"})["entry"]
        c.check("the interviewer opens with the problem and asks for an approach before code", "walk me through how you'd solve it" in intro["answer"])
        equal = next(e for e in interview.clarifications() if e.get("important"))
        entry = _http(port, "/api/ask", {"interview": iid, "question": f"Is the {equal['keywords'][0]} cheaper?"})["entry"]
        c.check("it answers a clarifying question from the facts", entry["matched"] and entry["topic"] == equal["topic"], entry["topic"] or "no match")

        clock.now += 160
        first = stuck()
        checkin = _http(port, "/api/stuck", {"interview": iid})["entry"]
        clock.now += 80
        c.check("quiet while reading: it checks in, but doesn't hand out a hint before you've started", first == "checkin" and checkin["kind"] == "checkin" and stuck() is None)

        write(SLOW_MAIN)
        slow = _http(port, "/api/test", {"interview": iid})
        c.check("a slow solution that passes gets asked for its complexity and a faster version",
                slow["result"]["ok"] and slow["assessed"]["event"] == "optimize" and slow["assessed"]["entry"]["kind"] == "cue:ac_optimize", slow["assessed"]["status"])
        again = _http(port, "/api/test", {"interview": iid})["assessed"]
        c.check("it asks once, and the follow-up waits for a faster version", again["event"] is None and state()["state"]["change_revealed_at"] is None)

        clock.now += 160
        first = stuck()
        _http(port, "/api/stuck", {"interview": iid})
        clock.now += 80
        second = stuck()
        hint = _http(port, "/api/stuck", {"interview": iid})["entry"]
        c.check("stuck while coding: it checks in, then gives the first hint", first == "checkin" and second == "hint" and hint["kind"] == "hint:1"
                and hint["answer"].startswith("Let me give you a small hint.") and interview.hints()[0] in hint["answer"])

        write((interview.solution / path).read_text(encoding="utf-8").split("\n\nclass PriceWatch")[0] + "\n")
        fast = _http(port, "/api/test", {"interview": iid})["assessed"]
        session = state()
        c.check("once it's fast, the follow-up comes, with its example added to your tests", fast["event"] == "followup" and session["state"]["change_reveal_reason"] == "solved"
                and (workspace / "tests" / "test_followup_example.py").exists())
        hint = _http(port, "/api/hint", {"interview": iid})["entry"]
        c.check("hints after the follow-up are the follow-up's own", interview.followup_hints()[0] in hint["answer"])

        write((workspace / path).read_text(encoding="utf-8") + SLOW_FOLLOWUP)
        slow = _http(port, "/api/test", {"interview": iid})
        c.check("a slow follow-up gets asked what each call costs", slow["result"]["ok"] and slow["assessed"]["event"] == "optimize"
                and slow["assessed"]["entry"]["kind"] == "cue:ac_optimize_followup", slow["assessed"]["status"])
        done = _http(port, "/api/done", {"interview": iid})
        c.check("Done coding after that moves on to the wrap-up", done["event"] == "wrap" and done["entry"]["kind"] == "cue:ac_wrap_early"
                and state()["phases"][state()["phase"]]["kind"] == "wrap")

        (workspace / "tests" / "test_regressions.py").write_text(CANDIDATE_TESTS[iid], encoding="utf-8")
        report = _http(port, "/api/submit", {"interview": iid})["report"]
        scores = {s["area"]: s for s in report["scores"]}
        kinds = [item["kind"] for item in report["help"]]
        c.check("the report scores the coding round's six areas", list(scores) == [a for a, _ in grading.CODING_ROUND_AREAS])
        c.check("it lists every time the interviewer stepped in", kinds.count("checkin") == 2 and kinds.count("hint") == 2 and kinds.count("optimize") == 2, ", ".join(kinds))
        c.check("problem solving notes the push to optimize and the hints", any("asked for a faster one" in line for line in scores["problem_solving"]["evidence"])
                and any("hints on the problem" in line for line in scores["problem_solving"]["evidence"]))
        c.check("the slow follow-up fails its large-input test, and the example tests aren't counted as yours",
                any("Follow-up: 100,000 adds" in m for m in report["missed_cases"]) and report["tests"]["your_new_tests"] == 1)
        parts = [p["part"] for p in report["timeline"]["parts"]]
        c.check("the report times your approach, the first version, making it faster, the follow-up, and the wrap-up",
                parts == ["Clarifying and your approach", "Coding a first version", "Making it faster", "The follow-up", "Wrap-up and your questions"], ", ".join(parts))
        c.check("the report shows how to solve it", "monotonic stack" in (report["approach"] or "") and bool(report["format_note"]))
        packet = _http(port, f"/api/packet?interview={iid}&kind=interviewer")["text"]
        c.check("the copyable interviewer prompt has the hints and the follow-up", interview.followup_hints()[0] in packet and interview.change_request()[:40] in packet
                and "Leadership Principles" not in packet)

        _http(port, "/api/start", {"interview": iid, "reset": True})
        write(WRONG_MAIN)
        first = _http(port, "/api/done", {"interview": iid})
        second = _http(port, "/api/done", {"interview": iid})
        c.check("Done coding with code that doesn't work yet: it asks you to test it, then moves on without the follow-up",
                first["event"] == "verify" and first["entry"]["kind"] == "cue:ac_verify" and second["event"] == "wrap" and state()["state"]["change_revealed_at"] is None)
    finally:
        server.shutdown()
        server.server_close()


def verify_learning_round(interview, home: Path, python: str, workspace: Path, scratch: Path, c: Checker) -> None:
    """The learning round: the starter works but is slow, each part's example fails on it and passes on the reference,
    the library does what its docs say, and the parts come one at a time."""
    from .session import PARTS_FILE
    parts = interview.parts()
    visible = run_pytest(python, workspace, ["tests"])
    c.check("the starter's own tests pass: the customer's code works before the parts", visible["ok"] and visible["total"] > 0)
    starter, solved = scratch / "starter", scratch / "solved"
    build_starter(interview, starter, home)
    build_starter(interview, solved, home)
    _overlay(interview.solution, solved)
    for folder in (starter, solved):
        for part in parts:
            shutil.copy2(part["tests_path"], folder / "tests" / part["tests_path"].name)
    failing = {case["module"] for case in run_pytest(python, starter, ["tests"])["cases"] if case["outcome"] != "passed"}
    c.check("every part's example test fails on the starter", all(part["tests_path"].stem in failing for part in parts), ", ".join(sorted(failing)))
    hidden = _hidden_run(python, interview, starter)
    c.check("the starter fails the grading tests", hidden["failed"] + hidden["errors"] > 0, f"{hidden['failed']} of {hidden['total']} fail")
    solved_visible, solved_hidden = run_pytest(python, solved, ["tests"]), _hidden_run(python, interview, solved)
    c.check("the reference solution passes every part's example and every grading test", solved_visible["ok"] and solved_hidden["ok"] and solved_hidden["total"] > 0,
            f"{solved_visible['passed']} visible, {solved_hidden['passed']}/{solved_hidden['total']} grading")
    c.check("each part has its task, example test, line, and hints, and the docs are there",
            bool(interview.docs()) and all(part["text"].strip() and part["tests_path"].is_file() and part["cue"] in interviewer.cues_for(interview) and part["hints"] for part in parts))
    # The round's library against its docs: interviewer/library_check.py, run in the workspace, prints "ok" or fails with what's wrong.
    check = interview.interviewer / "library_check.py"
    probe = subprocess.run([python, "-c", check.read_text(encoding="utf-8")], cwd=workspace, capture_output=True, encoding="utf-8", errors="replace", timeout=60) if check.is_file() else None
    c.check(f"{interview.library} does what its docs say ({interview.learning('checked', 'its main ideas')})", probe is not None and probe.returncode == 0 and probe.stdout.strip() == "ok",
            (probe.stdout + probe.stderr).strip()[-300:] if probe else "no interviewer/library_check.py")

    clock = FakeClock()
    sessions = Sessions(home, clock=clock)
    sessions.start(interview, reset=True)
    c.check("no part shows while you read", sessions.status(interview)["parts"] == [] and not (workspace / PARTS_FILE).exists())
    reading, began = next(p for p in interview.phases() if p.get("kind") == "learn"), clock.now
    clock.now = began + reading["end"] * 60 + 1
    status = sessions.status(interview)
    c.check("the first part comes when reading time is up, with its example test and TASKS.md",
            len(status["parts"]) == 1 and (workspace / "tests" / parts[0]["tests_path"].name).exists()
            and (workspace / PARTS_FILE).read_text(encoding="utf-8").startswith(parts[0]["text"].strip()[:30]))
    clock.now = began + interview.meta["duration_minutes"] * 60 + 1
    c.check("once time's up, passing tests don't bring another part", sessions.status(interview)["overtime"]
            and sessions.advance_part(interview, passed=True)["event"] is None and len(sessions.status(interview)["parts"]) == 1)
    report = reset_workspace(interview, home)
    fresh = scratch / "fresh"
    build_starter(interview, fresh, home)
    backup = Path(report["backup"])
    c.check("reset restores the starter and moves the parts' files to a backup",
            set(iter_files(workspace)) == set(iter_files(fresh)) and (backup / PARTS_FILE).exists() and (backup / "tests" / parts[0]["tests_path"].name).exists())


def verify_learning_workflow(interview, home: Path, c: Checker) -> None:
    """The learning round through the dashboard, with the scripted interviewer, then with a stand-in for Claude."""
    from .server import Lab, make_server
    print(f"\nLearning round workflow [{interview.id}]")
    clock = FakeClock()
    server = make_server(Lab(home, sessions=Sessions(home, clock=clock), api_config=api.ApiConfig(env={})), port=0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    iid, path, parts = interview.id, interview.meta["source_files"][0], interview.parts()
    workspace = workspace_path(interview, home)
    solution, starter = (interview.solution / path).read_text(encoding="utf-8"), (interview.starter / path).read_text(encoding="utf-8")
    session = lambda: _http(port, f"/api/state?interview={iid}")["session"]

    def write(code: str) -> None:
        loaded = _http(port, f"/api/file?interview={iid}&path={path}")
        _http(port, "/api/file", {"interview": iid, "path": path, "content": code, "mtime": loaded["mtime"]})

    try:
        start = _http(port, "/api/start", {"interview": iid, "reset": True})
        c.check(f"the dashboard gets {interview.library}'s docs, and no part yet", start["docs"] == interview.docs() and start["session"]["parts"] == [])
        question, section = interview.learning("docs_question"), interview.learning("docs_section")
        entry = _http(port, "/api/ask", {"interview": iid, "question": question})["entry"]
        c.check("a question the docs answer gets its answer and the section", bool(question) and entry["matched"] and section in entry["answer"], entry["answer"][:60])
        clock.now += 240
        c.check("quiet while you read: the interviewer lets you read", _http(port, f"/api/stuck?interview={iid}")["help"] is None)
        ready = _http(port, "/api/done", {"interview": iid})
        c.check("Ready for the task brings part 1, its line, and its example test", ready["event"] == "part" and ready["entry"]["kind"] == f"cue:{parts[0]['cue']}"
                and len(session()["parts"]) == 1 and (workspace / "tests" / parts[0]["tests_path"].name).exists())
        clock.now += 160
        first = _http(port, f"/api/stuck?interview={iid}")["help"]
        checkin = _http(port, "/api/stuck", {"interview": iid})["entry"]
        c.check("quiet on a part: it checks in", first == "checkin" and checkin["answer"] == interviewer.cues_for(interview)["pl_checkin"])
        write(solution)
        clock.now += 60
        ran = _http(port, "/api/test", {"interview": iid})
        c.check("passing tests bring the next part", ran["result"]["ok"] and ran["assessed"]["event"] == "part" and ran["assessed"]["entry"]["kind"] == f"cue:{parts[1]['cue']}")
        write(starter)
        first, second = _http(port, "/api/done", {"interview": iid}), _http(port, "/api/done", {"interview": iid})
        shown = session()["parts"]
        c.check("Next part with failing tests: it asks you to run them first, then moves on", first["event"] == "verify" and first["entry"]["kind"] == "cue:pl_verify"
                and not first["result"]["ok"] and second["event"] == "part" and len(shown) == 3 and shown[1]["skipped"])
        hint = _http(port, "/api/hint", {"interview": iid})["entry"]
        c.check("hints are the current part's own", parts[2]["hints"][0] in hint["answer"])
        write(solution)
        clock.now += 60
        _http(port, "/api/test", {"interview": iid})
        clock.now += 60
        last = _http(port, "/api/test", {"interview": iid})["assessed"]
        c.check("after the last part, on to the wrap-up", last["event"] == "wrap" and last["entry"]["kind"] == "cue:pl_wrap_early")
        report = _http(port, "/api/submit", {"interview": iid})["report"]
        c.check("the report scores the learning round's six areas", [s["area"] for s in report["scores"]] == [a for a, _ in grading.LEARNING_AREAS])
        c.check("it shows the parts, how the interviewer helped, and the time on each part",
                [p["done"] for p in report["parts"]] == [True, False, True, True] and {h["kind"] for h in report["help"]} >= {"checkin", "hint", "verify"}
                and [p["part"] for p in report["timeline"]["parts"]][:3] == ["Reading the docs", "Part 1", "Part 2 (moved on)"])
        c.check("the parts' example tests aren't counted as yours, and the interviewer writes the notes",
                report["tests"]["your_new_tests"] == 0 and report["notes_by"] == "learning" and bool(report["approach"]))
        packet = _http(port, f"/api/packet?interview={iid}&kind=interviewer")["text"]
        c.check("the copyable interviewer prompt has the docs and the parts", interview.docs()[:60] in packet and parts[3]["text"].strip()[:40] in packet)
        verify_learning_claude(interview, port, c)
    finally:
        server.shutdown()
        server.server_close()


def verify_learning_claude(interview, port: int, c: Checker) -> None:
    """The learning round's interviewer on a stand-in for Claude: what it sees while you read, and when it stays quiet."""
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
                self.wfile.write((json.dumps({"text": "What does section 3 say about that?"}) + "\n").encode())
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
        _http(port, "/api/start", {"interview": interview.id, "reset": True})
        events = coach({"trigger": "thinking", "message": "So jobs with the same key run in parallel?"})
        prompt = next(r for path, r in seen if path == "/api/claude-code")["prompt"]
        c.check(f"while you read, Claude has {interview.library}'s docs and checks your model without giving the task away",
                events[-1].get("done") and coach_ai.learning_role(interview) in prompt and interview.docs()[:80] in prompt
                and "same key run in parallel" in prompt and "Don't give them the first part yet" in prompt)
        before = len(seen)
        quiet = coach({"trigger": "stuck"})
        c.check("it doesn't step in while you're making progress", quiet[-1].get("done") and quiet[-1]["entry"] is None and len(seen) == before)
        _http(port, "/api/done", {"interview": interview.id})
        verify = _http(port, "/api/done", {"interview": interview.id})
        c.check("with Claude, Next part on failing tests leaves the words to Claude", verify["event"] == "verify" and verify["entry"] is None)
    finally:
        if previous is None:
            os.environ.pop("ROOMSIDE_URL", None)
        else:
            os.environ["ROOMSIDE_URL"] = previous
        coach_ai.status(force=True)
        bridge.shutdown()
        bridge.server_close()


def verify_amazon_clock(interview, port: int, c: Checker) -> None:
    """The interviewer keeps an hour's clock: it moves on when you finish a part early, and the report times each part."""
    state = lambda: _http(port, f"/api/state?interview={interview.id}")["session"]
    phase = lambda: (lambda s: s["phases"][s["phase"]]["name"])(state())
    _http(port, "/api/start", {"interview": interview.id, "reset": True})
    entry = _http(port, "/api/move-on", {"interview": interview.id, "cue": "amz_clarify"})["entry"]
    c.check("questions done early: the coding problem comes now", entry["kind"] == "cue:amz_clarify" and phase() == "Read and clarify the coding problem")
    path = interview.meta["editor_files"][0]
    loaded = _http(port, f"/api/file?interview={interview.id}&path={path}")
    _http(port, "/api/file", {"interview": interview.id, "path": path, "content": (interview.solution / path).read_text(encoding="utf-8"), "mtime": loaded["mtime"]})
    session = state()
    c.check("starting to code while you read starts the coding part, without a late \"go ahead\"",
            session["phases"][session["phase"]]["name"] == "Code it and talk it through" and "amz_code" in session["state"]["cues"] and session["state"]["coding"]["first_edit"] is not None)
    _http(port, "/api/test", {"interview": interview.id})
    c.check("passing tests bring the follow-up before its minute", state()["state"]["change_reveal_reason"] == "solved")
    done = _http(port, "/api/done", {"interview": interview.id})
    c.check("Done coding moves on to the dry run and your questions", done["next"] == "wrap" and done["entry"]["kind"] == "cue:amz_wrap_early" and phase().startswith("Dry run"))
    report = _http(port, "/api/submit", {"interview": interview.id})["report"]
    parts = [p["part"] for p in report["timeline"]["parts"]]
    # Here the follow-up comes within the same second as the first edit, so coding may be one part instead of two.
    c.check("the report times each part against the plan", parts[:2] == ["Introductions", "Reading and clarifying"] and parts[2] in ("Coding", "Coding the problem") and parts[-1] == "Dry run and your questions"
            and report["timeline"]["coding_minutes"] is not None and report["timeline"]["notes"], ", ".join(parts))


def run() -> int:
    python = test_python(practice_home())
    probe = subprocess.run([python, "-m", "pytest", "--version"], capture_output=True, encoding="utf-8", errors="replace")
    if probe.returncode:
        print(f"pytest is not available for {python}. Run: {LAB_COMMAND} setup")
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
