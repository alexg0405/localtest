"""Session state: the timer (with pauses), the scheduled requirement change, questions, notes, and test runs.

State is one JSON file per interview in <home>/.lab/sessions/. The clock is injectable
so the 30-minute change can be tested without waiting.
"""
from __future__ import annotations

import json
import random
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import interviewer
from .catalog import DEFAULT_PHASES, Interview, leadership_bank
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

    def start(self, interview: Interview, reset: bool = False, mode: str = "real") -> Dict[str, Any]:
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
                "mode": "coach" if mode == "coach" else "real",
                "mode_changes": [],
                "hints": [],
                "approach_revealed": False,
            }
            if reset_report:
                state["last_reset"] = reset_report
            plan = self._behavioral_plan(interview)
            if plan:
                state["behavioral"] = {"question": -1, "followup": 0, "awaiting": False, "answers": [], "plan": plan}
            self.save(state)
            return state

    def _behavioral_plan(self, interview: Interview) -> List[Dict[str, Any]]:
        """Picks this session's Leadership Principles questions from the shared bank: different principles, and the
        questions you were asked least recently, so repeat sessions don't repeat questions."""
        config = interview.meta.get("behavioral")
        if not config:
            return []
        bank = {entry["lp"]: entry for entry in leadership_bank()}
        history_path = self.home / ".lab" / "behavioral_history.json"
        try:
            history = {k: v for k, v in json.loads(history_path.read_text(encoding="utf-8")).items() if isinstance(v, list)}
        except (OSError, ValueError, AttributeError):
            history = {}
        rng = random.Random()
        focus = [lp for lp in config.get("focus", list(bank)) if lp in bank]
        rng.shuffle(focus)
        # Principles you've been asked least come first (then the longest ago), so sessions rotate through the bank.
        asked = lambda q: history.get(q["id"], [0, 0])  # [times asked, last asked]
        focus.sort(key=lambda lp: (sum(asked(q)[0] for q in bank[lp]["questions"]), max(asked(q)[1] for q in bank[lp]["questions"])))
        plan = []
        for lp in focus[: config.get("count", 2)]:
            question = min(bank[lp]["questions"], key=lambda q: (asked(q)[0], asked(q)[1], rng.random()))
            plan.append({"lp": lp, "id": question["id"], "question": question["q"], "followups": question["followups"],
                         "signals": bank[lp]["signals"], "look_for": bank[lp]["look_for"]})
            history[question["id"]] = [asked(question)[0] + 1, self.clock()]
        history_path.parent.mkdir(parents=True, exist_ok=True)
        history_path.write_text(json.dumps(history, indent=2), encoding="utf-8")
        return plan

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
            change_minutes = interview.meta.get("change_at_minutes", 30)
            change_at = change_minutes * 60 if change_minutes is not None else None  # a round can have no change
            if state["status"] == "running" and change_at is not None and elapsed >= change_at:
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
            reply = interviewer.answer(interview, question, state.get("change_revealed_at") is not None, state.get("mode", "real"))
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
        lines = interviewer.cues_for(interview, (self.load(interview.id) or {}).get("mode", "real"))
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

    @staticmethod
    def behavioral_questions(interview: Interview, state: Dict[str, Any]) -> List[Dict[str, Any]]:
        return state.get("behavioral", {}).get("plan") or interview.behavioral()

    def record_answer(self, interview: Interview, text: str) -> None:
        """Part of the candidate's answer to the behavioral prompt being asked. Before or after the questions, it is think-aloud."""
        text = " ".join(text.split())[:6000]
        if not text:
            return
        with LOCK:
            state = self._require(interview.id)
            flow = self._flow(state)
            if flow["answers"] and 0 <= flow["question"] < len(self.behavioral_questions(interview, state)):
                flow["answers"][-1]["parts"].append({"at": round(self.elapsed(state), 1), "text": text})
                flow["awaiting"] = False
                self.save(state)
                return
        self.record_speech(interview, text)

    def behavioral_next(self, interview: Interview) -> Optional[Dict[str, Any]]:
        """The next behavioral prompt: a follow-up on the current story, or the next question. None while an answer is
        still owed, or when every question has been asked."""
        with LOCK:
            state = self._require(interview.id)
            flow = self._flow(state)
            questions = self.behavioral_questions(interview, state)
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
                flow["answers"].append({"question": current["question"], "lp": current.get("lp"), "id": current.get("id"), "prompts": [], "parts": []})
                text = current["question"]
                kind = "behavioral:question"
            flow["answers"][-1]["prompts"].append(text)
            flow["awaiting"] = True
            entry = self._interviewer_message(state, text, kind)
            self.save(state)
            return entry

    # Real interview or coach: the coach gives hints freely, explains failures, and can show the approach.

    def set_mode(self, interview: Interview, mode: str) -> Dict[str, Any]:
        mode = "coach" if mode == "coach" else "real"
        with LOCK:
            state = self._require(interview.id)
            if state.get("mode", "real") != mode:
                state["mode"] = mode
                state.setdefault("mode_changes", []).append({"at": round(self.elapsed(state), 1), "mode": mode})
                self._interviewer_message(state, "Switching to coach mode. I'll help you along: ask for hints any time, and I'll help you read failing tests." if mode == "coach"
                                          else "Switching to real interview mode. From here I'll behave like a real interviewer, and hints will count against you.", f"mode:{mode}")
                self.save(state)
            return state

    @staticmethod
    def _activity(state: Dict[str, Any]) -> Dict[str, int]:
        """How many things the candidate has done so far: messages, speech, test runs, code runs, behavioral answers."""
        return {
            "questions": sum(1 for q in state.get("questions", []) if q.get("source") != "interviewer"),
            "spoken": len(state.get("spoken", [])),
            "test_runs": len(state.get("test_runs", [])),
            "code_runs": len(state.get("code_runs", [])),
            "answers": sum(len(a.get("parts", [])) for a in state.get("behavioral", {}).get("answers", [])),
        }

    def _progress_since(self, interview: Interview, state: Dict[str, Any], hint: Dict[str, Any]) -> bool:
        """Whether the candidate did anything after a hint: said or asked something, ran code, or edited it."""
        before = hint.get("activity")
        if before is None:
            return True  # a hint from before this was tracked
        now = self._activity(state)
        if any(now[key] > before.get(key, 0) for key in now):
            return True
        workspace = workspace_path(interview, self.home)
        for name in interview.meta.get("editor_files", []):
            try:
                if (workspace / name).stat().st_mtime > hint.get("wall", 0) + 0.5:
                    return True
            except OSError:
                pass
        return False

    def take_hint(self, interview: Interview) -> Optional[Dict[str, Any]]:
        """The hint to give now: {level, total, text, repeat}. A new level only after the candidate made progress since the
        last hint; asking again right away repeats the last level (not counted) so it can be rephrased. None when all are used."""
        hints = interview.hints()
        with LOCK:
            state = self._require(interview.id)
            used = state.setdefault("hints", [])
            if used and not self._progress_since(interview, state, used[-1]):
                level = used[-1]["level"]
                return {"level": level, "total": len(hints), "text": hints[level - 1], "repeat": True}
            if len(used) >= len(hints):
                return None
            used.append({"at": round(self.elapsed(state), 1), "wall": time.time(), "activity": self._activity(state), "level": len(used) + 1, "mode": state.get("mode", "real")})
            self.save(state)
            return {"level": len(used), "total": len(hints), "text": hints[len(used) - 1], "repeat": False}

    def record_coach(self, interview: Interview, trigger: str, message: str, reply: str, voice: bool = False) -> Dict[str, Any]:
        """Keeps a conversational coach exchange: the student's message and the reply, or the coach speaking up on its own."""
        with LOCK:
            state = self._require(interview.id)
            if trigger == "message" and message.strip():
                topic = interviewer.best_entry(interview.clarifications(), message).get("topic")
                entry = {"at": round(self.elapsed(state), 1), "question": message.strip()[:4000], "answer": reply, "topic": topic,
                         "matched": True, "source": "coach-ai", "voice": voice, "mode": state.get("mode", "real")}
                state["questions"].append(entry)
            else:
                entry = self._interviewer_message(state, reply, f"coach-ai:{trigger}")
            self.save(state)
            return entry

    def record_test_details(self, interview: Interview, result: Dict[str, Any]) -> None:
        with LOCK:
            state = self._require(interview.id)
            state["last_test_run"] = {"at": round(self.elapsed(state), 1), "passed": result.get("passed", 0), "failed": result.get("failed", 0), "errors": result.get("errors", 0),
                                      "failing": [{"name": c["name"], "message": c["message"]} for c in result.get("cases", []) if c["outcome"] != "passed"][:8]}
            self.save(state)

    def hint(self, interview: Interview) -> Dict[str, Any]:
        """The scripted hint, used when Claude isn't available."""
        hint = self.take_hint(interview)
        with LOCK:
            state = self._require(interview.id)
            coach = state.get("mode") == "coach"
            if hint is None:
                text = ("That's all my hints. If you want, open the menu and choose Show the approach, and I'll walk you through the whole solution." if coach
                        else "That's as much as I can give you. Try to take it from there, and tell me what you're thinking.")
                kind = "hint:none"
            elif hint["repeat"]:
                text = (f"Let's stay with the last hint for a moment: {hint['text']} Which part of it is unclear, or what would you try first?" if coach
                        else "I'd like to see you try the last hint first. What are you thinking?")
                kind = "hint:repeat"
            else:
                text = (f"Hint {hint['level']} of {hint['total']}: " if coach else "Sure, here's a nudge. ") + hint["text"]
                kind = f"hint:{hint['level']}"
            entry = self._interviewer_message(state, text, kind)
            self.save(state)
            return entry

    def reveal_approach(self, interview: Interview) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            if state.get("mode") != "coach":
                raise SessionError("Switch to coach mode to see the approach. A real interviewer won't show it.")
            state["approach_revealed"] = True
            entry = self._interviewer_message(state, "Here's how I'd solve it. Read it, then try writing it yourself without looking.\n\n" + interview.approach(), "approach")
            self.save(state)
            return entry

    def coach_on_tests(self, interview: Interview, result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """In coach mode, the interviewer reacts to a test run: what failed and what to try, or what to check next."""
        with LOCK:
            state = self._require(interview.id)
            if state.get("mode") != "coach" or interview.meta.get("format") != "problem":
                return None
            cases = interview.cases()
            failing = [c for c in result.get("cases", []) if c["outcome"] != "passed"]
            if failing:
                case = failing[0]
                about = cases.get(case["base"], {}).get("description", case["base"])
                if "NotImplementedError" in case["message"]:
                    text = "The tests fail because the function isn't written yet. Talk me through your plan first, and code the simplest version that handles the example."
                else:
                    text = f"{about} failed: {case['message']}. Try that input in Custom input and print what your code returns, then compare it with what you expected by hand. Want a hint?"
            elif result.get("total"):
                edges = [info["description"] for info in cases.values() if info.get("area") in ("edge", "performance")][:3]
                text = "All the example tests pass, nice! Before you submit, think about: " + "; ".join(edges) + "." if edges else "All the tests pass, nice!"
            else:
                return None
            entry = self._interviewer_message(state, text, "coach:tests")
            self.save(state)
            return entry

    def coach_nudge(self, interview: Interview) -> Optional[Dict[str, Any]]:
        with LOCK:
            state = self._require(interview.id)
            if state.get("mode") != "coach":
                return None
            entry = self._interviewer_message(state, "How's it going? Tell me what you're thinking right now, or ask for a hint if you're stuck. It's fine to start with the slow version.", "coach:nudge")
            self.save(state)
            return entry

    def record_code_run(self, interview: Interview, ok: bool) -> None:
        with LOCK:
            state = self._require(interview.id)
            state.setdefault("code_runs", []).append({"at": round(self.elapsed(state), 1), "ok": ok})
            self.save(state)

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
