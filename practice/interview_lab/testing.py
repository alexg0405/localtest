"""Runs pytest in a subprocess and reads per-test results from its JUnit XML report."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Sequence

from .catalog import LAB_COMMAND


def run_pytest(python: str, cwd: Path, paths: Sequence[str] = (), timeout: int = 180) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as scratch:
        report = Path(scratch) / "junit.xml"
        command = [python, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--import-mode=importlib",
                   "--continue-on-collection-errors", "-o", "junit_family=xunit2", f"--junitxml={report}", *paths]
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
        try:
            completed = subprocess.run(command, cwd=cwd, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            return _failure(f"pytest took longer than {timeout} seconds and was stopped (an infinite loop?).")
        except OSError as error:
            return _failure(f"Could not run pytest with {python}: {error}")
        output = (completed.stdout + completed.stderr)[-6000:]
        if "No module named pytest" in output:
            return _failure(f"pytest is not installed for this Python. Run: {LAB_COMMAND} setup", output)
        cases = _parse(report) if report.exists() else []
    counts = {outcome: sum(1 for case in cases if case["outcome"] == outcome) for outcome in ("passed", "failed", "error", "skipped")}
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "passed": counts["passed"],
        "failed": counts["failed"],
        "errors": counts["error"],
        "skipped": counts["skipped"],
        "total": len(cases),
        "cases": cases,
        "output": output,
    }


def _failure(message: str, output: str = "") -> Dict[str, Any]:
    return {"ok": False, "returncode": -1, "passed": 0, "failed": 0, "errors": 1, "skipped": 0, "total": 0, "cases": [], "output": (message + "\n" + output).strip()}


def _parse(report: Path) -> List[Dict[str, Any]]:
    cases = []
    for case in ET.parse(report).getroot().iter("testcase"):
        name, classname = case.get("name", ""), case.get("classname", "")
        outcome, message = "passed", ""
        for child in case:
            if child.tag in ("failure", "error", "skipped"):
                outcome = {"failure": "failed", "error": "error", "skipped": "skipped"}[child.tag]
                message = (child.get("message") or (child.text or "")).strip().splitlines()[0][:300] if (child.get("message") or child.text) else child.tag
                break
        collection_error = not classname  # a module that failed to import: its name is the module path
        module = (classname or name).split(".")[-1]
        cases.append({"id": f"{classname}::{name}", "classname": classname or name, "module": module, "name": name, "base": name.split("[")[0],
                      "outcome": outcome, "message": message, "collection_error": collection_error})
    return cases


def summary(result: Dict[str, Any]) -> Dict[str, Any]:
    """The part of a run worth keeping in session history."""
    return {key: result[key] for key in ("ok", "passed", "failed", "errors", "skipped", "total")}


def run_check(python: str, cwd: Path, script: Path, args: Sequence[str], fast_seconds: float, timeout: float) -> Dict[str, Any]:
    """Runs an interviewer-only check script against the candidate's code: is it correct, and is it fast enough to call
    optimal? The script prints a JSON line per check ({"check": "correct" | "speed", "ok", ...}), so a run stopped at the
    time limit still says whether the answers were right. Returns {"status": "fast" | "slow" | "wrong" | "missing", ...}."""
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    timed_out = False
    try:
        done = subprocess.run([python, str(script), *args], cwd=cwd, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout, env=env)
        output = done.stdout
    except subprocess.TimeoutExpired as error:
        timed_out = True
        output = error.stdout.decode("utf-8", "replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
    except OSError as error:
        return {"status": "missing", "seconds": None, "detail": f"Could not run the check: {error}"}
    lines = {}
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("check") in ("correct", "speed"):
            lines[event["check"]] = event
    correct, speed = lines.get("correct"), lines.get("speed")
    if not correct:
        return {"status": "wrong", "seconds": None, "detail": "it didn't finish on short histories (an infinite loop?)" if timed_out else "it crashed"}
    if not correct.get("ok"):
        return {"status": "missing" if correct.get("missing") else "wrong", "seconds": None, "detail": str(correct.get("detail", ""))[:300]}
    if speed is None:
        return {"status": "slow" if timed_out else "wrong", "seconds": None, "detail": f"over {timeout:g} seconds" if timed_out else "it crashed on the long history"}
    if not speed.get("ok"):
        return {"status": "wrong", "seconds": speed.get("seconds"), "detail": "wrong answer on the long history"}
    seconds = float(speed.get("seconds") or 0)
    return {"status": "fast" if seconds <= fast_seconds else "slow", "seconds": round(seconds, 3), "detail": ""}
