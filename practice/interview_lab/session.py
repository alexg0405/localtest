"""Session state: the timer (with pauses), the scheduled requirement change, questions, notes, and test runs.

State is one JSON file per interview in <home>/.lab/sessions/. The clock is injectable
so the 30-minute change can be tested without waiting.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import interviewer
from .catalog import DEFAULT_PHASES, Interview
from .workspace import create_workspace, reset_workspace, workspace_path

PHASES = DEFAULT_PHASES
NOTE_FIELDS = ("plan", "assumptions", "patch_review", "explanation", "transcript")
CHANGE_FILE = "CHANGE_REQUEST.md"
LOCK = threading.RLock()


class SessionError(Exception):
    pass


class Sessions:
    def __init__(self, home: Path, clock: Callable[[], float] = time.time):
        self.home = home
        self.clock = clock
        self.directory = home / ".lab" / "sessions"

    # Storage

    def _path(self, interview_id: str) -> Path:
        return self.directory / f"{interview_id}.json"

    def load(self, interview_id: str) -> Optional[Dict[str, Any]]:
        try:
            return json.loads(self._path(interview_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def save(self, state: Dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self._path(state["interview"])
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
        temporary.replace(path)

    def _require(self, interview_id: str) -> Dict[str, Any]:
        state = self.load(interview_id)
        if not state:
            raise SessionError("No session yet. Start the interview first.")
        return state

    # Timer

    def elapsed(self, state: Dict[str, Any]) -> float:
        end = state.get("submitted_at") or (state["paused_at"] if state.get("paused_at") else self.clock())
        return max(0.0, end - state["started_at"] - state.get("paused_total", 0.0))

    def start(self, interview: Interview, reset: bool = False) -> Dict[str, Any]:
        """Starts (or restarts) the session. With reset, the workspace goes back to the starter first."""
        with LOCK:
            workspace = workspace_path(interview, self.home)
            reset_report = None
            if reset and workspace.exists():
                reset_report = reset_workspace(interview, self.home)
            create_workspace(interview, self.home)
            previous = self.load(interview.id) or {}
            state = {
                "interview": interview.id,
                "started_at": self.clock(),
                "paused_at": None,
                "paused_total": 0.0,
                "status": "running",
                "change_revealed_at": None,
                "change_reveal_reason": None,
                "questions": [],
                "notes": {field: "" for field in NOTE_FIELDS},
                "test_runs": [],
                "spoken": [],
                "cues": [],
                "prompts_asked": {},
                "api_usage": {"requests": 0, "input_tokens": 0, "output_tokens": 0},
                "submitted_at": None,
                "restarts": previous.get("restarts", -1) + 1,
            }
            if reset_report:
                state["last_reset"] = reset_report
            self.save(state)
            return state

    def pause(self, interview: Interview) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            if state["status"] == "running":
                state["paused_at"] = self.clock()
                state["status"] = "paused"
                self.save(state)
            return state

    def resume(self, interview: Interview) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            if state["status"] == "paused":
                state["paused_total"] += self.clock() - state["paused_at"]
                state["paused_at"] = None
                state["status"] = "running"
                self.save(state)
            return state

    # Requirement change

    def reveal_change(self, interview: Interview, state: Dict[str, Any], reason: str) -> None:
        if state.get("change_revealed_at") is not None:
            return
        state["change_revealed_at"] = round(self.elapsed(state), 1)
        state["change_reveal_reason"] = reason
        workspace = workspace_path(interview, self.home)
        if workspace.exists():
            (workspace / CHANGE_FILE).write_text(interview.change_request(), encoding="utf-8")
        self.save(state)

    def reveal_now(self, interview: Interview) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            self.reveal_change(interview, state, "early")
            return state

    def status(self, interview: Interview) -> Dict[str, Any]:
        """The session as the dashboard sees it. Reveals the change once 30 minutes have run."""
        with LOCK:
            state = self.load(interview.id)
            if not state:
                return {"started": False}
            elapsed = self.elapsed(state)
            change_at = interview.meta.get("change_at_minutes", 30) * 60
            if state["status"] == "running" and elapsed >= change_at:
                self.reveal_change(interview, state, "scheduled")
            minutes = elapsed / 60
            phases = interview.phases()
            phase = next((i for i, p in enumerate(phases) if p["start"] <= minutes < p["end"]), len(phases))
            revealed = state.get("change_revealed_at") is not None
            return {
                "started": True,
                "state": state,
                "elapsed": elapsed,
                "duration": interview.meta.get("duration_minutes", 60) * 60,
                "change_at": change_at,
                "phase": phase,
                "phases": phases,
                "overtime": minutes >= interview.meta.get("duration_minutes", 60),
                "change": interview.change_request() if revealed else None,
                "workspace": str(workspace_path(interview, self.home)),
            }

    # Recording

    def ask(self, interview: Interview, question: str, voice: bool = False) -> Dict[str, Any]:
        question = question.strip()
        if not question:
            raise SessionError("Type a question first.")
        with LOCK:
            state = self._require(interview.id)
            reply = interviewer.answer(interview, question, state.get("change_revealed_at") is not None)
            entry = {"at": round(self.elapsed(state), 1), "question": question[:2000], **reply, "source": "offline", "voice": voice}
            state["questions"].append(entry)
            self.save(state)
            return entry

    def record_question(self, interview: Interview, entry: Dict[str, Any]) -> None:
        with LOCK:
            state = self._require(interview.id)
            state["questions"].append({"at": round(self.elapsed(state), 1), **entry})
            self.save(state)

    def record_speech(self, interview: Interview, text: str) -> None:
        """Something the candidate said out loud that was not a question: their think-aloud, kept as evidence."""
        text = " ".join(text.split())[:4000]
        if not text:
            return
        with LOCK:
            state = self._require(interview.id)
            spoken = state.setdefault("spoken", [])
            if sum(len(s["text"]) for s in spoken) < 400_000:
                spoken.append({"at": round(self.elapsed(state), 1), "text": text})
                self.save(state)

    def _interviewer_message(self, state: Dict[str, Any], text: str, kind: str) -> Dict[str, Any]:
        entry = {"at": round(self.elapsed(state), 1), "question": "", "answer": text, "topic": None, "matched": True, "source": "interviewer", "kind": kind}
        state["questions"].append(entry)
        return entry

    def cue(self, interview: Interview, name: str) -> Optional[Dict[str, Any]]:
        """The interviewer's line for a point in the session, said once per session."""
        lines = interviewer.cues_for(interview)
        if name not in lines:
            raise SessionError(f"Unknown cue {name!r}.")
        with LOCK:
            state = self._require(interview.id)
            if name in state.setdefault("cues", []):
                return None
            state["cues"].append(name)
            entry = self._interviewer_message(state, lines[name], f"cue:{name}")
            self.save(state)
            return entry

    def follow_up(self, interview: Interview, phase: str) -> Optional[Dict[str, Any]]:
        """The next follow-up question the interviewer has not asked yet, or None when there are no more."""
        phase = "plan" if phase == "plan" else "explain"
        with LOCK:
            state = self._require(interview.id)
            asked = state.setdefault("prompts_asked", {})
            prompts = interviewer.prompts_for(interview, phase)
            index = asked.get(phase, 0)
            if index >= len(prompts):
                return None
            asked[phase] = index + 1
            entry = self._interviewer_message(state, prompts[index], f"followup:{phase}")
            self.save(state)
            return entry

    # Leadership Principles questions: the interviewer asks one, digs in with follow-ups, then moves on.

    def _flow(self, state: Dict[str, Any]) -> Dict[str, Any]:
        return state.setdefault("behavioral", {"question": -1, "followup": 0, "awaiting": False, "answers": []})

    def record_answer(self, interview: Interview, text: str) -> None:
        """Part of the candidate's answer to the behavioral prompt being asked. Before or after the questions, it is think-aloud."""
        text = " ".join(text.split())[:6000]
        if not text:
            return
        with LOCK:
            state = self._require(interview.id)
            flow = self._flow(state)
            if flow["answers"] and 0 <= flow["question"] < len(interview.behavioral()):
                flow["answers"][-1]["parts"].append({"at": round(self.elapsed(state), 1), "text": text})
                flow["awaiting"] = False
                self.save(state)
                return
        self.record_speech(interview, text)

    def behavioral_next(self, interview: Interview) -> Optional[Dict[str, Any]]:
        """The next behavioral prompt: a follow-up on the current story, or the next question. None while an answer is
        still owed, or when every question has been asked."""
        questions = interview.behavioral()
        with LOCK:
            state = self._require(interview.id)
            flow = self._flow(state)
            if flow["awaiting"] or flow["question"] >= len(questions):
                return None
            current = questions[flow["question"]] if flow["question"] >= 0 else None
            if current and flow["followup"] < len(current.get("followups", [])):
                text = current["followups"][flow["followup"]]
                flow["followup"] += 1
                kind = "behavioral:followup"
            else:
                flow["question"] += 1
                flow["followup"] = 0
                if flow["question"] >= len(questions):
                    self.save(state)
                    return None
                current = questions[flow["question"]]
                flow["answers"].append({"question": current["question"], "lp": current.get("lp"), "prompts": [], "parts": []})
                text = current["question"]
                kind = "behavioral:question"
            flow["answers"][-1]["prompts"].append(text)
            flow["awaiting"] = True
            entry = self._interviewer_message(state, text, kind)
            self.save(state)
            return entry

    def set_note(self, interview: Interview, field: str, text: str) -> Dict[str, Any]:
        if field not in NOTE_FIELDS:
            raise SessionError(f"Unknown note field {field!r}.")
        with LOCK:
            state = self._require(interview.id)
            state["notes"][field] = text[:200_000]
            self.save(state)
            return state

    def record_test_run(self, interview: Interview, summary: Dict[str, Any]) -> None:
        with LOCK:
            state = self._require(interview.id)
            state["test_runs"].append({"at": round(self.elapsed(state), 1), **summary})
            self.save(state)

    def mark_submitted(self, interview: Interview) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            if not state.get("submitted_at"):
                if state.get("paused_at"):
                    state["paused_total"] += self.clock() - state["paused_at"]
                    state["paused_at"] = None
                state["submitted_at"] = self.clock()
            state["status"] = "submitted"
            self.save(state)
            return state

    def add_api_usage(self, interview: Interview, usage: Dict[str, int]) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            totals = state.setdefault("api_usage", {"requests": 0, "input_tokens": 0, "output_tokens": 0})
            totals["requests"] += 1
            totals["input_tokens"] += int(usage.get("input_tokens", 0))
            totals["output_tokens"] += int(usage.get("output_tokens", 0))
            self.save(state)
            return totals
