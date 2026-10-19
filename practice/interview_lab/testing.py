"""Runs pytest in a subprocess and reads per-test results from its JUnit XML report."""
from __future__ import annotations

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
