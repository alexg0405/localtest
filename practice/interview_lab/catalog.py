"""The interviews that ship with the lab, and where each one keeps its materials."""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Dict, List

LAB_ROOT = Path(__file__).resolve().parent.parent
INTERVIEWS_DIR = LAB_ROOT / "interviews"
PROBLEMS_DIR = LAB_ROOT / "problems"  # single-problem practice rounds
CONCEPTS = PROBLEMS_DIR / "_concepts.json"  # what the coach can explain
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
ORDER = ["commerce-orders", "banking-ledger", "unfamiliar-repo", "amazon-full-loop", "amazon-final-1", "amazon-final-2", "amazon-behavioral", "resume-deep-dive"]
LP_BANK = INTERVIEWS_DIR / "_amazon" / "leadership_principles.json"  # interviewer-only: questions, follow-ups, signals


def leadership_bank() -> List[Dict[str, Any]]:
    return json.loads(LP_BANK.read_text(encoding="utf-8")) if LP_BANK.exists() else []

# The default 60-minute AI-assisted flow. An interview can define its own "phases" in interview.json.
# "cue" names the interviewer's line at the start of the phase; "nudge" lets it ask follow-ups when you pause;
# "kind": "behavioral" turns what you say into answers to its Leadership Principles questions.
DEFAULT_PHASES = [
    {"start": 0, "end": 5, "name": "Read the task and clarify requirements", "cue": "start"},
    {"start": 5, "end": 15, "name": "Explore the repository and explain a plan", "cue": "plan", "nudge": "plan"},
    {"start": 15, "end": 40, "name": "Implement with AI assistance and run tests", "cue": "build"},
    {"start": 40, "end": 50, "name": "Check edge cases and review the AI patch", "cue": "edge"},
    {"start": 50, "end": 60, "name": "Explain your implementation and tradeoffs", "cue": "explain", "nudge": "explain"},
]


def practice_home() -> Path:
    """Where workspaces, sessions, and the test virtualenv live (outside this repository)."""
    return Path(os.environ.get("PRACTICE_HOME") or Path.home() / "interview-practice").expanduser()


WINDOWS = os.name == "nt"
# How to run the lab from the repository, for messages: the py launcher on Windows, where there is usually no python3.
LAB_COMMAND = "py practice\\lab.py" if WINDOWS else "python3 practice/lab.py"


def venv_python(venv: Path, windows: bool = WINDOWS) -> Path:
    """A virtualenv's Python: Scripts\\python.exe on Windows, bin/python elsewhere."""
    return venv / "Scripts" / "python.exe" if windows else venv / "bin" / "python"


def claude_rule_path(directory: Path, windows: bool = WINDOWS) -> str:
    """An absolute folder as Claude Code's permission rules write it: //Users/me/x, or //c/Users/me/x for C:\\Users\\me\\x."""
    if windows:
        path = PureWindowsPath(directory)
        return "//" + "/".join([path.drive[:1].lower(), *path.parts[1:]]) if path.drive else "/" + path.as_posix()
    return "/" + PurePosixPath(directory).as_posix()


def test_python(home: Path) -> str:
    """The Python that runs pytest: $PRACTICE_PYTHON, then the lab's virtualenv, then this Python."""
    if os.environ.get("PRACTICE_PYTHON"):
        return os.environ["PRACTICE_PYTHON"]
    venv = venv_python(home / ".venv")
    return str(venv) if venv.exists() else sys.executable


def shell_commands(workspace: Path, python: str, venv: Path, windows: bool = WINDOWS) -> Dict[str, str]:
    """Commands to copy into a terminal: PowerShell (Windows' default terminal) on Windows, a POSIX shell elsewhere."""
    if windows:
        return {
            "editor": f'code "{workspace}"',
            "assistant": f'cd "{workspace}"; claude',
            "tests": f'cd "{workspace}"; & "{python}" -m pytest -q',
            "activate": f'& "{venv / "Scripts" / "Activate.ps1"}"',
        }
    return {
        "editor": f'code "{workspace}"',
        "assistant": f'cd "{workspace}" && claude',
        "tests": f'cd "{workspace}" && "{python}" -m pytest -q',
        "activate": f'source "{venv / "bin" / "activate"}"',
    }


@dataclass(frozen=True)
class Interview:
    id: str
    root: Path
    meta: Dict[str, Any]

    @property
    def title(self) -> str:
        return self.meta["title"]

    @property
    def starter(self) -> Path:
        return self.root / "starter"

    @property
    def interviewer(self) -> Path:
        """Interviewer-only materials: guide, answers, solution, grading tests. Never copied to a workspace."""
        return self.root / "interviewer"

    @property
    def solution(self) -> Path:
        return self.interviewer / "solution"

    @property
    def grading_tests(self) -> Path:
        return self.interviewer / "grading_tests"

    def _text(self, name: str) -> str:
        path = self.interviewer / name
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def _json(self, name: str, default: Any) -> Any:
        path = self.interviewer / name
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default

    def change_request(self) -> str:
        return self._text("change_request.md")

    def guide(self) -> str:
        return self._text("guide.md")

    def rubric(self) -> str:
        return self._text("rubric.md")

    def clarifications(self) -> List[Dict[str, Any]]:
        return self._json("clarifications.json", [])

    def cases(self) -> Dict[str, Dict[str, Any]]:
        return self._json("cases.json", {})

    def patch_review(self) -> Dict[str, Any]:
        return self._json("patch_review.json", {})

    def followups(self) -> List[str]:
        """The guide's follow-up questions, without the answers it notes in parentheses."""
        match = re.search(r"^## Follow-up questions to ask\n(.*?)(?=^## |\Z)", self.guide(), re.M | re.S)
        items: List[str] = []
        for line in (match.group(1) if match else "").splitlines():
            if line.startswith("- "):
                items.append(line[2:].strip())
            elif items and line.strip():
                items[-1] += " " + line.strip()
        return [re.sub(r"\s*\([^()]*\)\s*$", "", item).strip() for item in items]

    def phases(self) -> List[Dict[str, Any]]:
        return self.meta.get("phases") or DEFAULT_PHASES

    @property
    def ai_allowed(self) -> bool:
        return self.meta.get("ai_allowed", True)

    def behavioral(self) -> List[Dict[str, Any]]:
        """Leadership Principles questions with their follow-ups (interviewer-only: which principle each probes)."""
        return self._json("behavioral.json", [])

    def hints(self) -> List[str]:
        return self._json("hints.json", [])

    def approach(self) -> str:
        return self._text("approach.md")

    def task(self) -> str:
        return (self.starter / "README.md").read_text(encoding="utf-8")

    def public(self) -> Dict[str, Any]:
        """What the dashboard may show before submission: nothing from the interviewer folder."""
        keys = ("id", "title", "inspired_by", "level", "summary", "duration_minutes", "change_at_minutes", "company", "format", "note_tabs", "tags", "editor_files", "custom_input", "number", "difficulty", "leetcode")
        public = {key: self.meta.get(key) for key in keys}
        public["ai_allowed"] = self.ai_allowed
        public["run_tests_allowed"] = self.meta.get("run_tests_allowed", True)
        public["phases"] = [{k: p[k] for k in ("start", "end", "name", "kind") if k in p} for p in self.phases()]
        public["hint_count"] = len(self.hints())
        return public


def concepts() -> List[Dict[str, Any]]:
    return json.loads(CONCEPTS.read_text(encoding="utf-8")) if CONCEPTS.exists() else []


def all_interviews() -> List[Interview]:
    found = {}
    for meta_path in INTERVIEWS_DIR.glob("*/interview.json"):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        found[meta["id"]] = Interview(id=meta["id"], root=meta_path.parent, meta=meta)
    problems = []
    for meta_path in PROBLEMS_DIR.glob("*/interview.json"):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        problems.append(Interview(id=meta["id"], root=meta_path.parent, meta=meta))
    problems.sort(key=lambda interview: interview.meta.get("order", 0))
    return [found[i] for i in ORDER if i in found] + [found[i] for i in sorted(found) if i not in ORDER] + problems


def get_interview(interview_id: str) -> Interview:
    for interview in all_interviews():
        if interview.id == interview_id:
            return interview
    raise KeyError(f"unknown interview {interview_id!r}; choose one of: {', '.join(i.id for i in all_interviews())}")
