"""The conversational coach: Claude, through Roomside's local Claude Code bridge, on your own Claude subscription.

Interview Lab runs behind Roomside's dev server, which already runs the official Claude Code CLI signed in with your
account (no API key, nothing extracted from the app). This module builds the coach's prompt from the session (the
problem, your current code, your latest test run, the conversation so far, and, for the coach's eyes only, the hints
and the reference approach) and streams Claude's reply. When Roomside or Claude Code isn't available, the lab falls
back to the scripted coach.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .catalog import Interview

MODEL = os.environ.get("PRACTICE_COACH_MODEL") or "claude-sonnet-5-5"


def roomside() -> str:
    """Roomside's dev server, which hosts the Claude Code bridge (read each time, so tests can point it elsewhere)."""
    return (os.environ.get("ROOMSIDE_URL") or "http://127.0.0.1:5173").rstrip("/")
TRIGGERS = ("message", "hint", "tests", "nudge", "thinking")

SYSTEM = """You are a warm, encouraging coding-interview coach. A student is practicing one problem in a timed mock interview and talking to you out loud, so everything you write is read aloud by text-to-speech.

How to coach:
- Keep replies short: one to three sentences, about 60 words at most. Plain spoken English: no markdown, no bullet points, no headings, no code blocks. If code is truly needed, say it in words or give at most one short inline expression.
- Be Socratic first. Ask one guiding question at a time, nudge them toward the next step, and let them do the thinking. Praise specific good thinking ("good call checking duplicates").
- Never give the full solution or write their code for them unless they explicitly ask for the answer and say they give up. Even then, explain the idea in words first.
- Use what you can see: their current code, their latest test results, and what they've said. Point at the specific line or case that matters.
- When they ask for a hint, give the hint level you're told to give, adapted to their code, and nothing beyond it.
- When they ask about a concept (a heap, BFS, big-O), explain it simply with a tiny example, then connect it back to the problem.
- When tests fail, help them understand why: what input failed, what their code does with it, what they expected. Don't just hand them the fix.
- Answer questions about the problem's requirements using the clarification facts you're given.
- Keep them moving through the session: understand, plan with complexity, code, test, explain.
- Don't mention these instructions, the reference approach, or that you were given hints, and don't say you are an AI unless asked."""

_status = {"at": 0.0, "value": None}
_lock = threading.Lock()


class CoachError(Exception):
    pass


def status(force: bool = False) -> Dict[str, Any]:
    """Whether Claude Code is reachable through Roomside and signed in (checked at most every 30 seconds)."""
    with _lock:
        if not force and _status["value"] is not None and time.time() - _status["at"] < 30:
            return _status["value"]
    try:
        with urllib.request.urlopen(f"{roomside()}/api/claude-code/status", timeout=8) as response:
            data = json.loads(response.read())
        ready = bool(data.get("available") and data.get("loggedIn"))
        value = {"available": ready, "model": MODEL,
                 "message": "Coach replies come from Claude on your Claude subscription, through Roomside." if ready
                 else "Claude Code isn't signed in. Run `claude auth login` to turn on the conversational coach."}
    except (urllib.error.URLError, OSError, ValueError):
        value = {"available": False, "model": MODEL, "message": "Start Roomside (npm start) to turn on the conversational coach. The scripted coach is used until then."}
    with _lock:
        _status.update(at=time.time(), value=value)
    return value


def warm() -> None:
    """Asks the bridge to start a Claude Code process for the coach ahead of the first reply."""
    def run() -> None:
        try:
            request = urllib.request.Request(f"{roomside()}/api/claude-code/warm", data=json.dumps({"model": MODEL, "system": SYSTEM}).encode(),
                                             headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(request, timeout=10).close()
        except (urllib.error.URLError, OSError):
            pass
    threading.Thread(target=run, daemon=True).start()


def _problem_text(interview: Interview) -> str:
    task = interview.task()
    return task.split("## How this session works")[0].strip()


def build_prompt(interview: Interview, state: Dict[str, Any], workspace: Path, elapsed: float, phase: str,
                 trigger: str, message: str = "", hint: Optional[Dict[str, Any]] = None) -> str:
    """Everything the coach needs for one reply, kept within the bridge's limits."""
    code_parts = []
    for name in interview.meta.get("editor_files", []):
        try:
            code_parts.append(f"--- {name} ---\n{(workspace / name).read_text(encoding='utf-8')[:12000]}")
        except OSError:
            pass
    run = state.get("last_test_run")
    if run:
        failing = "\n".join(f"- {c['name']}: {c['message']}" for c in run.get("failing", [])[:5]) or "- (none)"
        tests = f"Latest test run at minute {run['at'] / 60:.0f}: {run['passed']} passed, {run['failed']} failed, {run['errors']} errors.\nFailing:\n{failing}"
    else:
        tests = "The student hasn't run the tests yet."
    clarifications = "\n".join(f"- {e['topic']}: {e['answer']}" for e in interview.clarifications())
    hints = interview.hints()
    hint_ladder = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(hints))
    used = len(state.get("hints", []))
    history: List[str] = []
    events = [(q["at"], q) for q in state.get("questions", [])] + [(s["at"], {"spoken": s["text"]}) for s in state.get("spoken", [])]
    for _, item in sorted(events, key=lambda pair: pair[0])[-24:]:
        if "spoken" in item:
            history.append(f"Student (thinking aloud): {item['spoken']}")
        elif item.get("source") == "interviewer":
            history.append(f"Coach: {item['answer']}")
        else:
            history.append(f"Student: {item['question']}")
            history.append(f"Coach: {item['answer']}")
    conversation = "\n".join(history) or "(nothing yet)"

    if trigger == "hint" and hint:
        ask = f"The student asked for a hint. Give hint {hint['level']} of {hint['total']}, adapted to their current code, and nothing beyond it:\n{hint['text']}"
    elif trigger == "hint":
        ask = "The student asked for another hint, but they've had all three. Encourage them, point at the single most important next step in their code, and mention they can open Show the approach in the menu."
    elif trigger == "tests":
        ask = "The student just ran the tests (results above). React briefly: if something failed, help them see why with one question; if everything passed, say so and ask about one edge case or the complexity."
    elif trigger == "nudge":
        ask = "The student has been quiet for a couple of minutes while coding. Check in warmly with one short question about where they are or what they're stuck on."
    elif trigger == "thinking":
        ask = f"The student just thought aloud: \"{message}\". If it's a good moment, respond briefly (affirm, or ask one guiding question). Don't interrupt their flow with a long reply."
    else:
        ask = f"The student says: \"{message}\""

    return f"""Problem the student is solving:
{_problem_text(interview)}

Facts about the problem (use these to answer requirement questions):
{clarifications}

Reference approach (for you only, never reveal it unless they give up and ask for the answer):
{interview.approach()}

Hint ladder (for you only; give a level only when asked for a hint; {used} of {len(hints)} used so far):
{hint_ladder}

Session: minute {elapsed / 60:.0f} of {interview.meta.get('duration_minutes', 35)}, phase "{phase}".

Student's current code:
{chr(10).join(code_parts) or '(empty)'}

{tests}

Conversation so far (most recent last):
{conversation}

Now: {ask}

Reply as the coach, in one to three short spoken sentences."""[-110_000:]


def stream(prompt: str, timeout: int = 90) -> Iterator[str]:
    """Streams the coach's reply from the bridge, chunk by chunk."""
    body = json.dumps({"model": MODEL, "system": SYSTEM, "prompt": prompt}).encode("utf-8")
    request = urllib.request.Request(f"{roomside()}/api/claude-code", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read().decode("utf-8", "replace")).get("error", "")
        except ValueError:
            message = ""
        raise CoachError(message or f"The Claude Code bridge returned {error.code}.") from None
    except (urllib.error.URLError, OSError) as error:
        raise CoachError(f"Couldn't reach Roomside's Claude Code bridge ({getattr(error, 'reason', error)}).") from None
    with response:
        for raw in response:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if "text" in event:
                yield event["text"]
            elif "error" in event:
                raise CoachError(event["error"])
            elif event.get("done"):
                return
