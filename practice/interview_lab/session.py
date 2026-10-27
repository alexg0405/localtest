"""Session state: the timer (with pauses), the scheduled requirement change, questions, notes, and test runs.

State is one JSON file per interview in <home>/.lab/sessions/. The clock is injectable
so the 30-minute change can be tested without waiting.
"""
from __future__ import annotations

import json
import random
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import interviewer, resume
from .catalog import DEFAULT_PHASES, Interview, leadership_bank
from .workspace import create_workspace, reset_workspace, workspace_path

PHASES = DEFAULT_PHASES
NOTE_FIELDS = ("plan", "assumptions", "patch_review", "explanation", "transcript")
CHANGE_FILE = "CHANGE_REQUEST.md"
LOCK = threading.RLock()
# The coding round's interviewer, with a candidate who seems stuck: it checks in after this long without progress
# (nothing said, typed, or run), gives a hint if there's still nothing a little after that, and steps in when the same
# tests keep failing for a few minutes. Its follow-up waits this long after it asked for a faster version.
QUIET_SECONDS = 150
HINT_AFTER_CHECKIN = 75
SPINNING_SECONDS = 180
OPTIMIZE_GRACE = 240
FOLLOW_UP_MINUTES = 4   # the least coding time left for the follow-up to be worth giving
STUCK_ESCALATE = 240    # still stuck this long after a hint, with nothing tried: the next one is bigger


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
        for attempt in range(40):
            try:
                temporary.replace(path)
                return
            except PermissionError:  # Windows: another thread is reading the file right now
                if attempt == 39:
                    raise
                time.sleep(0.025)

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
        principles = self._pick_principles(config.get("focus"), config.get("count", 2))
        if config.get("bank") == "resume":  # the résumé interview: questions from your résumé, then its principles section
            saved = resume.load(self.home)
            plan = resume.plan(saved["text"] if saved else "", principles)
            # A round that borrows only some of the résumé questions (the full Amazon interview: one deep dive, then the principles).
            keep = config.get("resume_items")
            return [item for item in plan if keep is None or item["id"] in keep or item["kind"] == "leadership"]
        return principles

    def _pick_principles(self, focus: Optional[List[str]], count: int) -> List[Dict[str, Any]]:
        """This session's principles questions, shared by every round that asks them, so a principle you were just asked
        in one round comes up later in another."""
        bank = {entry["lp"]: entry for entry in leadership_bank()}
        history_path = self.home / ".lab" / "behavioral_history.json"
        try:
            history = {k: v for k, v in json.loads(history_path.read_text(encoding="utf-8")).items() if isinstance(v, list)}
        except (OSError, ValueError, AttributeError):
            history = {}
        rng = random.Random()
        focus = [lp for lp in (focus or list(bank)) if lp in bank]
        rng.shuffle(focus)
        # Principles you've been asked least come first (then the longest ago), so sessions rotate through the bank.
        asked = lambda q: history.get(q["id"], [0, 0])  # [times asked, last asked]
        focus.sort(key=lambda lp: (sum(asked(q)[0] for q in bank[lp]["questions"]), max(asked(q)[1] for q in bank[lp]["questions"])))
        plan = []
        for lp in focus[:count]:
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
            examples = interview.followup_tests
            for source in sorted(examples.glob("test_*.py")) if examples and examples.is_dir() else []:
                target = workspace / "tests" / source.name   # the follow-up's example, so Run tests checks it too
                if not target.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
        self.save(state)

    def reveal_now(self, interview: Interview) -> Dict[str, Any]:
        with LOCK:
            state = self._require(interview.id)
            self.reveal_change(interview, state, "early")
            return state

    @staticmethod
    def bounds(interview: Interview, state: Dict[str, Any]) -> List[Tuple[float, float]]:
        """When each part of the interview really starts and ends, in minutes. The plan's times, except that a part the
        interviewer moved on to early starts then, and a part marked "keeps_length" (reading the problem) keeps its own
        length when it starts early, so the part after it (the coding) starts sooner and gets the time you saved."""
        moved = {int(i): at / 60 for i, at in state.get("moved_on", {}).items()}
        bounds: List[Tuple[float, float]] = []
        for i, part in enumerate(interview.phases()):
            start = min(part["start"], moved.get(i, part["start"]), bounds[-1][1] if bounds else part["start"])
            end = part["end"]
            if part.get("keeps_length") and start < part["start"]:
                end = min(end, start + part["end"] - part["start"])
            bounds.append((start, end))
        return bounds

    @classmethod
    def _phase(cls, interview: Interview, state: Dict[str, Any], minutes: float) -> int:
        """Which part of the interview it is, by its real start (see bounds), or the résumé interview's Leadership
        Principles section, which opens a little early with your first answer once its time is near."""
        phases = interview.phases()
        bounds = cls.bounds(interview, state)
        phase = len(phases) if not bounds or minutes >= bounds[-1][1] else max(i for i, (start, _) in enumerate(bounds) if start <= minutes)
        section = next((i for i, p in enumerate(phases) if p.get("principles")), None)
        if section is not None and phase < section and minutes < phases[section]["end"] and any(q.get("section") for q in state.get("questions", [])):
            phase = section
        return phase

    def move_on(self, interview: Interview, cue: str, say: Optional[str] = None, quiet: bool = False) -> Optional[Dict[str, Any]]:
        """Starts the part of the interview that `cue` opens now, ahead of the clock, and says that cue, or `say` (another
        cue) in its place. Quiet, it says nothing: the interviewer is about to open the part in its own words. None when
        that part had already begun, or when quiet."""
        phases = interview.phases()
        index = next((i for i, p in enumerate(phases) if p.get("cue") == cue), None)
        if index is None:
            raise SessionError(f"No part of this interview starts with {cue!r}.")
        with LOCK:
            state = self._require(interview.id)
            ahead = self._phase(interview, state, self.elapsed(state) / 60) < index
            if ahead:
                state.setdefault("moved_on", {})[str(index)] = int(self.elapsed(state) * 10) / 10   # rounded down, so it has begun
                self.save(state)
        if quiet or (ahead and say):
            self.skip_cue(interview, cue)
        if quiet or not ahead:
            return None
        return self.cue(interview, say or cue)

    def record_edit(self, interview: Interview) -> None:
        """You changed your code in the editor: when you first and last did. Starting while you read the problem (a part
        marked "ends_on_edit") starts the coding part, so the interviewer doesn't later tell you to start."""
        with LOCK:
            state = self._require(interview.id)
            if state["status"] != "running":
                return
            at = round(self.elapsed(state), 1)
            coding = state.setdefault("coding", {"first_edit": at, "edits": 0})
            coding["last_edit"] = at
            coding["edits"] += 1
            phases = interview.phases()
            phase = self._phase(interview, state, at / 60)
            if phase + 1 < len(phases) and phases[phase].get("ends_on_edit"):
                state.setdefault("moved_on", {})[str(phase + 1)] = int(self.elapsed(state) * 10) / 10
                if phases[phase + 1].get("cue") and phases[phase + 1]["cue"] not in state.setdefault("cues", []):
                    state["cues"].append(phases[phase + 1]["cue"])   # "go ahead and code it" would come too late
            self.save(state)

    def done_coding(self, interview: Interview) -> Dict[str, Any]:
        """You told the interviewer you're done coding: the follow-up comes next if it hasn't been given yet, and after it
        the wrap-up (the dry run, complexity, and your questions), ahead of the clock."""
        with LOCK:
            state = self._require(interview.id)
            at = round(self.elapsed(state), 1)
            state.setdefault("coding", {"first_edit": None, "edits": 0}).setdefault("done", []).append(at)
            pending = interview.meta.get("change_at_minutes") is not None and state.get("change_revealed_at") is None
            if pending:
                self.reveal_change(interview, state, "done")
            else:
                self.save(state)
        if pending:
            return {"next": "followup", "entry": None}   # the page says the follow-up's line, as for one on the clock
        wrap = next((p for p in interview.phases() if p.get("kind") == "wrap"), None)
        early = "amz_wrap_early" if "amz_wrap_early" in interviewer.cues_for(interview) else None
        return {"next": "wrap", "entry": self.move_on(interview, wrap["cue"], say=early) if wrap and wrap.get("cue") else None}

    # The coding round: the interviewer checks a working solution's speed, asks for a faster one when it can be
    # optimized, gives the follow-up once it's fast, and helps when you're stuck.

    @staticmethod
    def stage(state: Dict[str, Any]) -> str:
        """The part of the coding round's problem you're on: "main", then "followup" once it's revealed."""
        return "followup" if state.get("change_revealed_at") is not None else "main"

    @classmethod
    def _follow_up_due(cls, interview: Interview, state: Dict[str, Any], elapsed: float) -> bool:
        """Whether the follow-up comes now that its minute has passed. In the coding round it waits for a solution that
        works: it comes as soon as that's fast, or a few minutes after the interviewer asked for a faster one, while
        there's still time to code it."""
        if interview.meta.get("format") != "amazon-coding":
            return True
        asked = (state.get("optimize") or {}).get("main")
        fast = any(check["status"] == "fast" for check in (state.get("speed") or {}).get("main", []))
        return (fast or (asked is not None and elapsed - asked >= OPTIMIZE_GRACE)) and not cls._too_late(interview, state, elapsed)

    @classmethod
    def _too_late(cls, interview: Interview, state: Dict[str, Any], elapsed: float) -> bool:
        """Too little coding time left to start the follow-up."""
        index = next((i for i, p in enumerate(interview.phases()) if p.get("kind") == "coding"), None)
        return index is not None and cls.bounds(interview, state)[index][1] - elapsed / 60 < FOLLOW_UP_MINUTES

    def assess(self, interview: Interview, check: Dict[str, Any], done: bool = False, scripted: bool = False) -> Dict[str, Any]:
        """What the coding round's interviewer does after checking the current part (a speed check from
        testing.run_check), when your tests pass or when you say you're done coding. {"event", "entry"}:
        - "optimize": it works but is slower than it needs to be, so the interviewer asks for its complexity and a
          faster version (once per part).
        - "verify": you said you're done, but it doesn't work yet, so it asks you to test it (once per part).
        - "followup": the main problem is done (fast, or as fast as you got it): the follow-up is revealed, and the page
          says its line.
        - "wrap": the follow-up is done, you're done coding, or the main problem is done with too little time left for
          the follow-up: on to the wrap-up, whose line is the entry.
        - None: nothing to say (it passes but is still slow, and the interviewer already asked for better).
        Scripted, the entry is the interviewer's scripted line for "optimize" and "verify"; otherwise Claude words them."""
        with LOCK:
            state = self._require(interview.id)
            stage, at, status = self.stage(state), round(self.elapsed(state), 1), check["status"]
            state.setdefault("speed", {}).setdefault(stage, []).append({"at": at, "status": status, "seconds": check.get("seconds")})
            asked, verified = state.setdefault("optimize", {}), state.setdefault("verify", {})
            if done:
                state.setdefault("coding", {"first_edit": None, "edits": 0}).setdefault("done", []).append(at)
            if status == "slow" and stage not in asked:
                asked[stage], event = at, "optimize"
            elif status in ("wrong", "missing") and done and stage not in verified:
                verified[stage], event = at, "verify"
            elif stage == "main" and (status == "fast" or (done and status == "slow")) and interview.meta.get("change_at_minutes") is not None:
                event = "wrap" if self._too_late(interview, state, self.elapsed(state)) else "followup"
                if event == "followup":
                    self.reveal_change(interview, state, "solved" if status == "fast" else "done")
            elif done or (stage == "followup" and status == "fast"):
                event = "wrap"
            else:
                event = None
            self.save(state)
        if event == "wrap":
            wrap = next((p for p in interview.phases() if p.get("kind") == "wrap"), None)
            entry = self.move_on(interview, wrap["cue"], say="ac_wrap_early" if "ac_wrap_early" in interviewer.cues_for(interview) else None) if wrap and wrap.get("cue") else None
        elif event in ("optimize", "verify") and scripted:
            entry = self.cue(interview, "ac_verify" if event == "verify" else "ac_optimize_followup" if stage == "followup" else "ac_optimize")
        else:
            entry = None
        return {"event": event, "entry": entry, "stage": stage, "status": status}

    @staticmethod
    def _last_progress(state: Dict[str, Any]) -> float:
        """When you last did something: said, asked, or typed anything, or ran your code or the tests (seconds in)."""
        times = [0.0, (state.get("coding") or {}).get("last_edit") or 0.0]
        times += [item["at"] for item in state.get("spoken", [])] + [q["at"] for q in state.get("questions", []) if q.get("source") != "interviewer"]
        times += [run["at"] for run in state.get("test_runs", []) + state.get("code_runs", [])]
        return max(times)

    @staticmethod
    def help_given(state: Dict[str, Any]) -> List[Tuple[float, str]]:
        """When the interviewer stepped in to help, and how: "checkin", "hint", or "debug" (the same tests keep failing)."""
        given = []
        for q in state.get("questions", []):
            kind = q.get("kind") or ""
            if q.get("source") != "interviewer":
                continue
            if kind in ("coach-ai:nudge", "checkin"):
                given.append((q["at"], "checkin"))
            elif kind == "coach-ai:hint" or kind.startswith("hint:"):
                given.append((q["at"], "hint"))
            elif kind in ("coach-ai:debug", "debug"):
                given.append((q["at"], "debug"))
        return given

    def stuck_help(self, interview: Interview) -> Optional[str]:
        """Whether the coding round's interviewer should step in now, and how:
        - "debug": the last three test runs failed the same way over three minutes or more, with no help since.
        - "checkin": two and a half minutes without progress, and no help since then.
        - "hint": still nothing 75 seconds after checking in, once you've started coding (or reading time is over),
          while hints are left.
        None otherwise: you're making progress, or it just stepped in."""
        with LOCK:
            state = self.load(interview.id)
            if not state or state["status"] != "running" or interview.meta.get("format") != "amazon-coding":
                return None
            now = self.elapsed(state)
            phases = interview.phases()
            phase = self._phase(interview, state, now / 60)
            if phase >= len(phases) or phases[phase].get("kind") not in ("approach", "coding"):
                return None
            given = self.help_given(state)
            runs = state.get("test_runs", [])[-3:]
            if (len(runs) == 3 and all(run.get("failing") for run in runs) and len({tuple(run["failing"]) for run in runs}) == 1
                    and now - runs[0]["at"] >= SPINNING_SECONDS and not any(at >= runs[0]["at"] for at, _ in given)):
                return "debug"
            progress = self._last_progress(state)
            if now - progress < QUIET_SECONDS:
                return None
            since = [(at, kind) for at, kind in given if at >= progress]
            if not since:
                return "checkin"
            last_at, last_kind = since[-1]
            coding = (state.get("coding") or {}).get("first_edit") is not None or phases[phase].get("kind") == "coding"
            stage, hints = self._ladder(interview, state)
            left = len(hints) - sum(1 for h in state.get("hints", []) if h.get("stage", "main") == stage)
            if last_kind == "checkin" and now - last_at >= HINT_AFTER_CHECKIN and coding and left > 0:
                return "hint"
            if last_kind != "checkin" and now - last_at >= QUIET_SECONDS:
                return "checkin"
            return None

    def checkin(self, interview: Interview) -> Dict[str, Any]:
        """The scripted interviewer checking in on a quiet candidate (said as often as it's needed)."""
        with LOCK:
            state = self._require(interview.id)
            entry = self._interviewer_message(state, interviewer.cues_for(interview).get("ac_checkin", "Where are you at? Talk me through what you're thinking."), "checkin")
            self.save(state)
            return entry

    def debug_nudge(self, interview: Interview) -> Dict[str, Any]:
        """The scripted interviewer's nudge when the same tests keep failing: find the bug yourself, by hand."""
        with LOCK:
            state = self._require(interview.id)
            entry = self._interviewer_message(state, "Let's slow down for a second. Pick the smallest input that fails, trace your code on it by hand, line by line, and tell me where it stops doing what you expect.", "debug")
            self.save(state)
            return entry

    def reveal_when_solved(self, interview: Interview) -> bool:
        """The visible tests pass before the follow-up's minute: the interviewer gives the follow-up now. True if it did."""
        with LOCK:
            state = self._require(interview.id)
            if state["status"] != "running" or state.get("change_revealed_at") is not None or interview.meta.get("change_at_minutes") is None:
                return False
            self.reveal_change(interview, state, "solved")
            return True

    def status(self, interview: Interview) -> Dict[str, Any]:
        """The session as the dashboard sees it. Reveals the change once 30 minutes have run."""
        with LOCK:
            state = self.load(interview.id)
            if not state:
                return {"started": False}
            elapsed = self.elapsed(state)
            change_minutes = interview.meta.get("change_at_minutes", 30)
            change_at = change_minutes * 60 if change_minutes is not None else None  # a round can have no change
            if state["status"] == "running" and change_at is not None and elapsed >= change_at and self._follow_up_due(interview, state, elapsed):
                self.reveal_change(interview, state, "scheduled")
            minutes = elapsed / 60
            phases = interview.phases()
            phase = self._phase(interview, state, minutes)
            revealed = state.get("change_revealed_at") is not None
            return {
                "started": True,
                "state": state,
                "elapsed": elapsed,
                "duration": interview.meta.get("duration_minutes", 60) * 60,
                "change_at": change_at,
                "phase": phase,
                "phases": phases,
                "bounds": [[round(start, 2), round(end, 2)] for start, end in self.bounds(interview, state)],
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
            entry = {"at": round(self.elapsed(state), 1), "n": self._seq(state), "question": question[:2000], **reply, "source": "offline", "voice": voice}
            state["questions"].append(entry)
            self.save(state)
            return entry

    def record_question(self, interview: Interview, entry: Dict[str, Any]) -> None:
        with LOCK:
            state = self._require(interview.id)
            state["questions"].append({"at": round(self.elapsed(state), 1), "n": self._seq(state), **entry})
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
                spoken.append({"at": round(self.elapsed(state), 1), "n": self._seq(state), "text": text})
                self.save(state)

    @staticmethod
    def _seq(state: Dict[str, Any]) -> int:
        """The order things were said in, for lines recorded within the same tenth of a second."""
        state["seq"] = state.get("seq", 0) + 1
        return state["seq"]

    def _interviewer_message(self, state: Dict[str, Any], text: str, kind: str) -> Dict[str, Any]:
        entry = {"at": round(self.elapsed(state), 1), "n": self._seq(state), "question": "", "answer": text, "topic": None, "matched": True, "source": "interviewer", "kind": kind}
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
            text = lines[name]
            index = next((i for i, p in enumerate(interview.phases()) if p.get("cue") == name), None)
            if "{left}" in text and index is not None:  # "about {left} minutes for coding": what's really left of that part
                text = text.replace("{left}", str(max(1, round(self.bounds(interview, state)[index][1] - self.elapsed(state) / 60))))
            entry = self._interviewer_message(state, text, f"cue:{name}")
            self.save(state)
            return entry

    def skip_cue(self, interview: Interview, name: str) -> None:
        """Counts a cue as said without saying it, when the interviewer moves on before its time in other words."""
        if name not in interviewer.cues_for(interview, (self.load(interview.id) or {}).get("mode", "real")):
            raise SessionError(f"Unknown cue {name!r}.")
        with LOCK:
            state = self._require(interview.id)
            if name not in state.setdefault("cues", []):
                state["cues"].append(name)
                self.save(state)

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
                flow["answers"][-1]["parts"].append({"at": round(self.elapsed(state), 1), "n": self._seq(state), "text": text})
                flow["awaiting"] = False
                self.save(state)
                return
        self.record_speech(interview, text)

    def behavioral_next(self, interview: Interview) -> Optional[Dict[str, Any]]:
        """The next behavioral prompt, in its scripted words: a follow-up on the current story, or the next question. None
        while an answer is still owed, or when every question has been asked."""
        step = self.behavioral_step(interview)
        return self.record_behavioral_prompt(interview, step, step["text"]) if step else None

    def behavioral_step(self, interview: Interview) -> Optional[Dict[str, Any]]:
        """Moves the plan on to its next prompt and says what it is (its kind, scripted words, and question), without
        saying it yet: record_behavioral_prompt keeps the words the interviewer used. None, as for behavioral_next."""
        with LOCK:
            state = self._require(interview.id)
            flow = self._flow(state)
            questions = self.behavioral_questions(interview, state)
            if flow["awaiting"] or flow["question"] >= len(questions):
                return None
            now = self.elapsed(state)
            section, left = self._lp_clock(interview, state, flow, questions, now)
            if section and now >= section["end"] * 60:
                return None   # the clock has moved on to the next part of the interview
            current = questions[flow["question"]] if flow["question"] >= 0 else None
            # A story that has had its share of the time gets no more follow-ups, if another question is still to come.
            hurried = bool(current and flow["followup"] < len(current.get("followups", [])) and flow["question"] + 1 < len(questions) and left is not None and left <= 0)
            if current and flow["followup"] < len(current.get("followups", [])) and not hurried:
                step = {"kind": "behavioral:followup", "text": current["followups"][flow["followup"]], "followup": flow["followup"]}
                flow["followup"] += 1
            else:
                flow["question"] += 1
                flow["followup"] = 0
                if flow["question"] >= len(questions):
                    self.save(state)
                    return None
                current = questions[flow["question"]]
                flow["answers"].append({"question": current["question"], "lp": current.get("lp"), "id": current.get("id"), "prompts": [], "parts": [], "asked_at": round(now, 1)})
                step = {"kind": "behavioral:question", "text": ("In the interest of time, let's move on. " if hurried else "") + current["question"], "hurried": hurried}
                section, left = self._lp_clock(interview, state, flow, questions, now)
            flow["awaiting"] = True
            self.save(state)
            return {**step, "index": flow["question"], "item": current, "seconds_left": None if left is None else max(0, round(left))}

    @staticmethod
    def _lp_clock(interview: Interview, state: Dict[str, Any], flow: Dict[str, Any], questions: List[Dict[str, Any]], now: float):
        """The Amazon rounds' Leadership Principles part, and the seconds left for the current story: its share of the time
        that was left in the part when it was asked. (None, None) for rounds without that pacing."""
        if interview.meta.get("format") not in ("amazon-final", "amazon-behavioral"):
            return None, None
        section = next((p for p in interview.phases() if p.get("kind") == "behavioral"), None)
        answer = flow["answers"][-1] if flow["answers"] and flow["question"] >= 0 else None
        if not section or not answer or answer.get("asked_at") is None:
            return section, None
        share = (section["end"] * 60 - answer["asked_at"]) / max(1, len(questions) - flow["question"])
        return section, answer["asked_at"] + share - now

    def record_behavioral_prompt(self, interview: Interview, step: Dict[str, Any], text: str) -> Dict[str, Any]:
        """Says the prompt behavioral_step chose, in the words given (its scripted ones, or Claude's)."""
        text = " ".join(str(text).split()) or step["text"]
        with LOCK:
            state = self._require(interview.id)
            flow = self._flow(state)
            if flow["answers"]:
                flow["answers"][-1]["prompts"].append(text)
            entry = self._interviewer_message(state, text, step["kind"])
            if step["kind"] == "behavioral:question" and step["item"].get("section"):
                entry["section"] = step["item"]["section"]
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

    @staticmethod
    def _ladder(interview: Interview, state: Dict[str, Any]) -> Tuple[str, List[str]]:
        """Which hints apply now: the problem's, or in the coding round, the follow-up's own once it's revealed."""
        if interview.meta.get("format") == "amazon-coding" and state.get("change_revealed_at") is not None and interview.followup_hints():
            return "followup", interview.followup_hints()
        return "main", interview.hints()

    def take_hint(self, interview: Interview, reason: str = "asked") -> Optional[Dict[str, Any]]:
        """The hint to give now: {level, total, text, repeat, stage}. A new level only after the candidate made progress since
        the last hint; asking again right away repeats the last level (not counted) so it can be rephrased. None when all are
        used. `reason` is "asked", or "stuck" when the coding round's interviewer offers it: someone still stuck well after
        the last hint gets the next one even without progress."""
        with LOCK:
            state = self._require(interview.id)
            stage, hints = self._ladder(interview, state)
            used = [h for h in state.setdefault("hints", []) if h.get("stage", "main") == stage]
            stale = bool(used) and reason == "stuck" and self.elapsed(state) - used[-1]["at"] >= STUCK_ESCALATE
            if used and not stale and not self._progress_since(interview, state, used[-1]):
                level = used[-1]["level"]
                return {"level": level, "total": len(hints), "text": hints[level - 1], "repeat": True, "stage": stage, "reason": reason}
            if len(used) >= len(hints):
                return None
            level = len(used) + 1
            state["hints"].append({"at": round(self.elapsed(state), 1), "wall": time.time(), "activity": self._activity(state), "level": level,
                                   "mode": state.get("mode", "real"), "stage": stage, "reason": reason})
            self.save(state)
            return {"level": level, "total": len(hints), "text": hints[level - 1], "repeat": False, "stage": stage, "reason": reason}

    def record_coach(self, interview: Interview, trigger: str, message: str, reply: str, voice: bool = False, section: Optional[str] = None) -> Dict[str, Any]:
        """Keeps a conversational coach exchange: the student's message and the reply, or the coach speaking up on its own."""
        with LOCK:
            state = self._require(interview.id)
            if trigger == "message" and message.strip():
                topic = interviewer.best_entry(interview.clarifications(), message).get("topic")
                entry = {"at": round(self.elapsed(state), 1), "n": self._seq(state), "question": message.strip()[:4000], "answer": reply, "topic": topic,
                         "matched": True, "source": "coach-ai", "voice": voice, "mode": state.get("mode", "real")}
                state["questions"].append(entry)
            else:
                entry = self._interviewer_message(state, reply, f"coach-ai:{trigger}")
            if section:
                entry["section"] = section  # this reply opens a new section of the interview
            self.save(state)
            return entry

    def record_test_details(self, interview: Interview, result: Dict[str, Any]) -> None:
        with LOCK:
            state = self._require(interview.id)
            state["last_test_run"] = {"at": round(self.elapsed(state), 1), "passed": result.get("passed", 0), "failed": result.get("failed", 0), "errors": result.get("errors", 0),
                                      "failing": [{"name": c["name"], "message": c["message"]} for c in result.get("cases", []) if c["outcome"] != "passed"][:8]}
            self.save(state)

    def hint(self, interview: Interview, reason: str = "asked") -> Dict[str, Any]:
        """The scripted hint, used when Claude isn't available."""
        hint = self.take_hint(interview, reason)
        with LOCK:
            state = self._require(interview.id)
            coach = state.get("mode") == "coach"
            stuck = reason == "stuck"
            if hint is None:
                text = ("That's all my hints. If you want, open the menu and choose Show the approach, and I'll walk you through the whole solution." if coach
                        else "That's as much as I can give you. Try to take it from there, and tell me what you're thinking.")
                kind = "hint:none"
            elif hint["repeat"]:
                text = (f"Let's stay with the last hint for a moment: {hint['text']} Which part of it is unclear, or what would you try first?" if coach
                        else f"Let me put my last hint another way. {hint['text']}" if stuck
                        else "I'd like to see you try the last hint first. What are you thinking?")
                kind = "hint:repeat"
            else:
                text = (f"Hint {hint['level']} of {hint['total']}: " if coach else "Let me give you a small hint. " if stuck else "Sure, here's a nudge. ") + hint["text"]
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
