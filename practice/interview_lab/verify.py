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
import urllib.request
from pathlib import Path
from typing import Callable, List

from . import api
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

        # 2. Starter defects are detectable.
        visible = run_pytest(python, workspace, ["tests"])
        c.check("starter fails visible tests", visible["failed"] + visible["errors"] > 0 and visible["passed"] > 0, f"{visible['passed']} pass, {visible['failed']} fail")
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
        patched = scratch / "patched"
        build_starter(interview, patched, home)
        subprocess.run(["git", "init", "-q"], cwd=patched, check=True)
        applied = subprocess.run(["git", "apply", "patch_review/ai_patch.diff"], cwd=patched, capture_output=True, text=True)
        c.check("AI patch applies to the starter", applied.returncode == 0, applied.stderr.strip()[:200])
        if applied.returncode == 0:
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
        clock.now += 19 * 60 + 59
        before = sessions.status(interview)
        no_file = not (workspace / CHANGE_FILE).exists()
        clock.now += 1
        after = sessions.status(interview)
        c.check("change is hidden before minute 30 and while paused", paused["change"] is None and before["change"] is None and no_file, f"{before['elapsed'] / 60:.2f} min")
        c.check("change appears at minute 30 in the dashboard and CHANGE_REQUEST.md",
                after["change"] == interview.change_request() and (workspace / CHANGE_FILE).read_text(encoding="utf-8") == interview.change_request()
                and after["state"]["change_reveal_reason"] == "scheduled", f"revealed at {after['state']['change_revealed_at'] / 60:.1f} min")

        # 6. Reset restores the starter and deletes nothing.
        source = workspace / interview.meta["source_files"][-1]
        original = source.read_text(encoding="utf-8")
        source.write_text(original + "\n# candidate edit\n", encoding="utf-8")
        (workspace / "notes").mkdir(exist_ok=True)
        (workspace / "notes" / "mine.txt").write_text("keep me", encoding="utf-8")
        deleted = workspace / interview.meta["source_files"][0]
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


def verify_workflow(interview, home: Path, c: Checker) -> None:
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
        before = _http(port, "/api/test", {"interview": interview.id})["result"]
        c.check("visible tests run from the dashboard and show the starter failures", before["failed"] > 0)

        starter_report = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in starter_report["scores"]}
        c.check("submitting the untouched starter scores correctness low", scores["correctness"] <= 2 and starter_report["missed_cases"], f"correctness {scores['correctness']}")

        workspace = workspace_path(interview, home)
        _overlay(interview.solution, workspace)  # stands in for the candidate's work
        (workspace / "tests" / "test_regressions.py").write_text(CANDIDATE_TESTS[interview.id], encoding="utf-8")
        _http(port, "/api/reveal", {"interview": interview.id})
        after = _http(port, "/api/test", {"interview": interview.id})["result"]
        c.check("visible tests pass after the fix", after["ok"], f"{after['passed']} passed")
        report = _http(port, "/api/submit", {"interview": interview.id})["report"]
        scores = {s["area"]: s["score"] for s in report["scores"]}
        c.check("report has all eight areas", len(report["scores"]) == 8)
        c.check("fixed workspace passes every grading test", report["tests"]["grading"]["failed"] + report["tests"]["grading"]["errors"] == 0 and scores["correctness"] == 5)
        c.check("a regression test that fails on the starter is credited", report["tests"]["your_tests_that_catch_starter_bugs"] >= 1)
        c.check("areas without evidence are 'not observed'", scores["ai_instructions"] is None)
        c.check("report lists three improvements and a follow-up exercise", len(report["improvements"]) == 3 and report["follow_up"]["exercise"])
        grading_prompt = _http(port, f"/api/packet?interview={interview.id}&kind=grading")["text"]
        interviewer_prompt = _http(port, f"/api/packet?interview={interview.id}&kind=interviewer")["text"]
        c.check("copyable grading and interviewer prompts are produced", "not observed" in grading_prompt and interview.change_request()[:40] in interviewer_prompt)
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
    saved = {key: os.environ.get(key) for key in ("PRACTICE_HOME", "PRACTICE_PYTHON", "ANTHROPIC_API_KEY", "PRACTICE_API_MODE")}
    with tempfile.TemporaryDirectory() as scratch:
        home = Path(scratch) / "home"
        home.mkdir()
        os.environ["PRACTICE_HOME"] = str(home)
        os.environ["PRACTICE_PYTHON"] = python
        os.environ.pop("ANTHROPIC_API_KEY", None)
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
