"""The interviews that ship with the lab, and where each one keeps its materials."""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

LAB_ROOT = Path(__file__).resolve().parent.parent
INTERVIEWS_DIR = LAB_ROOT / "interviews"
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
ORDER = ["commerce-orders", "banking-ledger", "unfamiliar-repo"]


def practice_home() -> Path:
    """Where workspaces, sessions, and the test virtualenv live (outside this repository)."""
    return Path(os.environ.get("PRACTICE_HOME") or Path.home() / "interview-practice").expanduser()


def test_python(home: Path) -> str:
    """The Python that runs pytest: $PRACTICE_PYTHON, then the lab's virtualenv, then this Python."""
    if os.environ.get("PRACTICE_PYTHON"):
        return os.environ["PRACTICE_PYTHON"]
    venv = home / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


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

    def task(self) -> str:
        return (self.starter / "README.md").read_text(encoding="utf-8")

    def public(self) -> Dict[str, Any]:
        """What the dashboard may show before submission: nothing from the interviewer folder."""
        keys = ("id", "title", "inspired_by", "level", "summary", "duration_minutes", "change_at_minutes")
        return {key: self.meta.get(key) for key in keys}


def all_interviews() -> List[Interview]:
    found = {}
    for meta_path in INTERVIEWS_DIR.glob("*/interview.json"):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        found[meta["id"]] = Interview(id=meta["id"], root=meta_path.parent, meta=meta)
    return [found[i] for i in ORDER if i in found] + [found[i] for i in sorted(found) if i not in ORDER]


def get_interview(interview_id: str) -> Interview:
    for interview in all_interviews():
        if interview.id == interview_id:
            return interview
    raise KeyError(f"unknown interview {interview_id!r}; choose one of: {', '.join(i.id for i in all_interviews())}")
