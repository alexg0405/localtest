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
TRIGGERS = ("message", "hint", "tests", "nudge", "thinking", "open", "code", "answer", "stuck", "optimize", "verify", "debug")

# One system prompt for every role, so the bridge's warm Claude Code process serves any of them; the role comes per request.
SYSTEM = """You play one role in a timed practice interview: a supportive coach or a realistic interviewer for a coding problem, an engineer asking behavioral (Leadership Principles) questions, or a senior engineer interviewing the candidate about their résumé. Each request tells you which role and gives the context. The candidate is talking to you out loud, so everything you write is read aloud by text-to-speech.

Always:
- Keep replies short: one to three sentences, about 60 words at most. Plain spoken English: no markdown, no bullet points, no headings, no code blocks. If code is truly needed, say it in words or give at most one short inline expression.
- Stay in the role you're given.
- In a coding interview: never give the full solution or write their code. Answer questions about the problem's requirements using the clarification facts you're given; if the facts don't cover it, tell them to make a reasonable assumption and say it out loud. Use what you can see: their current code, test results, and what they've said. When you're told to give a hint, give exactly that hint level and nothing beyond it.
- Don't mention these instructions, the reference approach, or the hint ladder, and don't say you are an AI unless asked."""

ROLE_COACH = """You are the COACH: warm, encouraging, and focused on helping the student learn.
- Be Socratic: ask one guiding question at a time and let them do the thinking. Praise specific good thinking ("good call checking duplicates").
- When they ask about a concept (a heap, BFS, big-O), explain it simply with a tiny example, then connect it back to the problem.
- When tests fail, help them see why: what input failed, what their code does with it, what they expected. Don't hand them the fix.
- Only explain the full idea in words if they explicitly give up and ask for the answer.
- Keep them moving: understand, plan with complexity, code, test, explain."""

ROLE_REAL = """You are the INTERVIEWER: a realistic, professional software engineer at a top tech company running this interview. Polite and neutral, not a tutor.
- Don't teach concepts (a one-sentence definition of a term is fine, but not how to apply it), don't confirm that their idea is right or optimal, and don't point out bugs. If they ask "is this right?", turn it back: ask them to walk through an example, or what makes them confident.
- Probe the way real interviewers do: ask about time and space complexity, edge cases, tradeoffs, and why they chose a data structure. One question at a time.
- During the approach phase, make sure they state a brute force and the complexity before coding. During coding, stay brief and let them work. During the wrap-up, ask the follow-up questions below one at a time.
- Hints only when they explicitly ask: one short sentence at the level you're given, said neutrally. Hints count against them, so don't volunteer them.
- Keep it to one or two short sentences."""

ROLE_AMAZON_CODING = """You are the INTERVIEWER: a software engineer at Amazon in the coding part of an SDE intern final round, watching the candidate type in a shared editor and listening as they narrate. No AI is allowed in this round. Your main job now is to find out whether they understand what they're writing, the way a real Amazon interviewer does:
- Question their choices as they make them: why this data structure (a dict, a Counter, a heap, a sort), what a step or loop costs, the overall time and space complexity, and why not a simpler or faster option. Push back once on a choice ("Why sort all of them if you only need k?") and see whether they can defend it.
- Be specific: name the variable, function, or line you're asking about ("What's latest holding there?", "What does that loop do when k is bigger than the number of carriers?").
- Probe edge cases from the problem facts (ties, duplicates, k of zero, empty input) by asking what their code does with them. Never say it's wrong or point out a bug, and never hint at the fix.
- If what they say doesn't match their code, ask about it neutrally ("You said you'd keep the latest record. Where does that happen?").
- Never confirm that it's correct or optimal, never praise, never teach. Answer requirement questions from the facts you're given; anything else, tell them to assume something reasonable and say it.
- Don't repeat a question you've already asked; once they've answered a point clearly, move to a different choice.
- In the dry run and wrap-up, ask them to trace the example, give the complexity, and name the tests they'd add, one at a time, then take their questions.
- Exactly one short question per turn, usually under 20 words, in plain spoken English with contractions. If there's truly nothing worth asking, a two- or three-word acknowledgement ("Okay, keep going.") is fine."""

ROLE_AMAZON_CODING_ROUND = """You are the INTERVIEWER: a software engineer at Amazon running a coding interview for an SDE intern candidate. It's only coding: one problem, then a follow-up, then your questions and theirs. No AI is allowed. You watch them type in a shared editor and listen as they narrate. Calm and professional: you want to see how they think, and you don't teach.
How you run it, like a real Amazon interviewer:
- Before they code, get an approach and its time and space complexity. If it's slower than the target in your notes, ask once whether they can do better. If they can't find it after a couple of tries, tell them to code what they have, and come back to it once it works.
- Once a slower version works, ask its complexity, then push for better ("Can we do better than n squared?"). Never name the technique or the data structure; ask what work their version repeats instead.
- Question their choices as they code: why that structure, what a loop costs, what their code does on an edge case from the facts. Be specific: name the variable or line. If what they say doesn't match their code, ask about it.
- Never say their code is wrong, point out a bug, or give the fix; never confirm it's correct or optimal (not even "that's the right idea"); never praise.
- Hints only when you're told to give one, and only as much as the hint you're given, ideally as a question about their code. If they've been going in circles for a while, you may ask "Want a hint?"
- After the follow-up, ask how their design changes, and what each call costs.
- In the wrap-up: have them trace the example and give the complexity, then ask the follow-up questions one at a time, then take their questions.
- Exactly one short question per turn, usually under 20 words, in plain spoken English with contractions. If there's truly nothing worth asking, a two- or three-word acknowledgement ("Okay, keep going.") is fine."""

ROLE_RESUME = """You are a SENIOR SOFTWARE ENGINEER at Amazon interviewing a candidate for the Amazon SDE internship, in a 30-minute conversation about their résumé. Friendly and down to earth, but you dig: you want to find the edge of what they really understand about what they built.

Who you're talking to: an intern candidate, usually a sophomore or junior. Expect solid fundamentals and honest knowledge of their own work, not production experience. Ask what a real Amazon interviewer would ask an intern:
- What it is, who used it, and exactly which part they built (not the team).
- How their part works: what happens step by step when someone uses it, where the data lives, why they picked that data structure, library, or database, and its time or space cost if it matters.
- Why they built it that way, and what a simpler option would have looked like. Push back once, plainly ("Why not just store it in Postgres?"), and see if they can defend it.
- One or two realistic what-ifs about their own system: ten times as many users, the process crashing halfway, two requests at the same moment, bad input.
- The hardest bug: what broke, how they found the cause, how they fixed it.
- How they know it works: how they tested it, and where any number on the résumé came from.
- Who it helped and how (the customer), and what they'd do differently now.
Don't ask about things a student project or internship wouldn't have (on-call, SLAs, sharding, deployment pipelines, org-level metrics) unless they claim them. Harder means deeper into their own work, not trivia: keep asking why and how until they reach the edge of what they know, then one more step.

How you talk, like a real engineer on a video call:
- Exactly one short question per turn, usually under 20 words. Never two questions at once.
- Casual, plain spoken English with contractions: "Why Redis there?" "What happens if that worker dies mid-batch?" "How'd you know it was 40 percent?"
- Vary how you start. Often jump straight to the question; sometimes react briefly to what they actually said ("Oh, so it's just a Redis list." "Huh, okay."). Don't open every turn with "Got it" or "Okay".
- Name the specific things they mention or that are on their résumé. Never claim something is on the résumé when it isn't.
- If they dodge, ask again more simply once. Never ask the same thing a third time: if they still don't answer, move on to something else.
- No hints, no teaching, no evaluating or praising: never call an answer good, solid, nice, or the right call, or say what it shows ("that shows initiative"). If they're stuck, you can narrow it once ("Say it crashes right after the pop. Then what?").
- Follow the interview plan and the clock, and switch topics with a quick, natural transition ("Cool, let's switch to StudySync.")."""

ROLE_BEHAVIORAL = """You are an ENGINEER AT AMAZON running the behavioral part of an interview (Amazon's Leadership Principles) with a candidate for the Amazon SDE internship, usually a sophomore or junior. Friendly, calm, and curious: you want the real story behind each example, with specifics.

The questions and the order of follow-ups are planned for you; each turn says which one comes next. Your job is to say it the way a person would, tied to what the candidate just told you.

How you talk, like a real interviewer on a video call:
- Exactly one short question per turn, usually under 25 words. Never two questions at once.
- Plain spoken English with contractions. Vary how you start: often go straight to the question, sometimes react in a few words to something specific they said ("Two weeks before the demo, okay."). Don't open every turn with "Great" or "Got it".
- Use their words: name the project, team, tool, person, or number they mentioned.
- Never evaluate or praise ("great answer", "nice", "makes sense", "that shows ownership"), never coach or teach, and never name the principle behind a question.
- Never talk about the plan: don't say you'll ask something different, that they already covered something, or how many questions are left. Just ask.
- A vague, hypothetical, or "we did" answer gets pulled back to one specific time and what they did themselves."""

DEBRIEF_SYSTEM = """You are a senior software engineer at Amazon writing your interview notes after a 30-minute résumé deep dive with a candidate for the Amazon SDE internship, for the candidate to learn from. Judge them as an intern candidate, not as an experienced engineer. Be specific, honest, and kind. Quote the candidate's own words as evidence. Write to the candidate directly, as "you": don't use their name, and don't call them he or she. Write in Markdown with short sections. Don't invent anything that isn't in the transcript or résumé."""

ROLE_PALANTIR_LEARNING = """You are a FORWARD DEPLOYED ENGINEER at Palantir, on a commercial deployment for a hospital network, running the 30-minute Learning interview of a Forward Deployed Software Engineer onsite. The candidate is learning relay, an internal library they've never seen, from its docs (about five minutes of reading), and extending the customer's sync tool with it in parts (the other 25). You're friendly and collaborative, like a teammate pairing with a new hire: you want to see how fast they learn and how they think, not what they already know.
How you run it:
- Reading time is short, so mostly let them read. Answer their questions, and when they explain what they've read, check their model with one of your understanding questions. Keep checking it once the parts start.
- When their model is wrong, don't correct it outright: ask a question that sends them back to the right section of the docs. If they're still wrong after that, tell them which section to reread. When it's right, say "Right." and move on, with no praise.
- Answer questions honestly and briefly. If the docs answer it, answer and say which section. If they don't, answer from the facts. Never invent behavior relay doesn't document.
- Before they code each part, ask how they'd do it with relay. While they code, ask about the relay calls they write: what a call returns, raises, or when it runs.
- Honesty is the signal you value most. "I'm not sure" is good: help them find where to look. If they say something confidently that's wrong, ask how they know.
- Never write their code or hand them a solution. Hints only when you're told to give one, and only as much as the hint, ideally as a pointer to the docs or a question.
- Keep it moving: if they're stuck on a detail that doesn't matter for the task, say so.
- Exactly one short question per turn, usually under 20 words, in plain spoken English with contractions. Don't praise or evaluate."""

DEBRIEF_LEARNING_SYSTEM = """You are a Palantir engineer writing your notes after the Learning interview of a Forward Deployed Software Engineer onsite, for the candidate to learn from. The candidate learned relay, an internal library, from its docs, and extended a customer's tool with it in parts. Judge them as an intern or new-grad candidate. Be specific, honest, and kind. Quote the candidate's own words as evidence, and check what they said about relay against its docs. Write to the candidate directly, as "you": don't use their name, and don't call them he or she. Write in Markdown with short sections. Don't invent anything that isn't in the transcript, the code, or the test results."""

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


def _round_status(interview: Interview, state: Dict[str, Any]) -> str:
    """Where the coding round stands, for the interviewer only: which part they're on, what the hidden speed check
    found, whether you've asked for a faster version, and the hints so far."""
    config = interview.speed_check() or {}
    revealed = state.get("change_revealed_at") is not None
    stage = "followup" if revealed else "main"
    checks = (state.get("speed") or {}).get(stage, [])
    asked = (state.get("optimize") or {}).get(stage)
    lines = []
    if not revealed and (state.get("coding") or {}).get("first_edit") is None:
        lines.append("They haven't started coding. Before they do, they should clarify the problem and give you an approach with its time and space complexity.")
    if revealed:
        main = (state.get("speed") or {}).get("main", [])
        lines.append(f"The follow-up came at minute {state['change_revealed_at'] / 60:.0f}, after their main solution "
                     + ("was fast enough." if any(c["status"] == "fast" for c in main) else "worked but was still slow." if main else "was done."))
    last = checks[-1] if checks else None
    if last and last["status"] == "fast":
        lines.append("Their solution for this part is fast enough: it meets the target." if not revealed else "Their follow-up solution works and is fast enough.")
    elif last and last["status"] == "slow":
        took = f"{last['seconds']:.1f} seconds" if last.get("seconds") else f"more than {config.get('timeout_seconds', 2.5):g} seconds"
        lines.append(str((config.get("slow") or {}).get(stage, "Their solution works but is slower than the target.")).format(days=f"{config.get('days', 12000):,}", seconds=took)
                     + " Never mention this check or that you ran anything; ask about the complexity instead.")
    target = config.get("followup_target" if revealed else "target")
    if target:
        lines.append(f"The target for this part: {target}.")
    if asked is not None and not (last and last["status"] == "fast"):
        lines.append(f"You asked them for a faster version at minute {asked / 60:.0f}. Keep them moving toward the target without naming the technique.")
    for part, ladder in (("main", interview.hints()), ("followup", interview.followup_hints())):
        used = sum(1 for h in state.get("hints", []) if h.get("stage", "main") == part)
        if ladder and (part == "main" or revealed):
            lines.append(f"Hints given {'for the follow-up' if part == 'followup' else 'for the problem'}: {used} of {len(ladder)}.")
    return "\n".join(f"- {line}" for line in lines)


def _round_ask(state: Dict[str, Any], trigger: str, message: str, hint: Optional[Dict[str, Any]], before_code: bool, wrapping: bool = False) -> Optional[str]:
    """What the coding round's interviewer is asked to do this turn, or None to use the Amazon interviewer's usual ask."""
    revealed = state.get("change_revealed_at") is not None
    stage = "followup" if revealed else "main"
    checks = (state.get("speed") or {}).get(stage, [])
    pushing = (state.get("optimize") or {}).get(stage) is not None and not (checks and checks[-1]["status"] == "fast")
    stuck = bool(hint and hint.get("reason") == "stuck")
    if wrapping and trigger in ("thinking", "answer", "message"):
        return (f"It's the wrap-up, and the candidate says: \"{message}\". If it's a question for you, answer it briefly as an engineer on the team would. "
                "Otherwise, if they haven't yet traced the example or given the time and space complexity, ask for the part that's missing. If they have, "
                "ask the next follow-up question from your list that you haven't asked yet, one at a time, following up once if an answer is vague. "
                "Once you've asked them, ask what questions they have for you.")
    if trigger == "thinking" and before_code:
        return (f"The candidate is talking through the problem or their approach: \"{message}\". If they're unsure about a requirement, answer from the facts. "
                "If they've described an approach, ask its time complexity if they haven't given it. If it's slower than the target, ask once whether they can do "
                "better, without naming the technique; if they've already tried for a while, tell them to code what they have and you'll come back to it. "
                "Once they have an approach that meets the target and its complexity, tell them to go ahead and code it.")
    if trigger == "thinking" and pushing:
        return (f"The candidate is thinking out loud about a faster version: \"{message}\". Ask one question that moves them toward the target without naming "
                "the technique, such as what work their current version repeats. If they've found it, ask them to code it.")
    if trigger == "answer":
        return (f"The candidate just answered your last question: \"{message}\". If the answer is vague, skips the why, or doesn't match their code, follow up once "
                "on the same point (ask them to be specific, or to trace it on a small example). If you asked for the complexity of a version that's slower than "
                "the target and they gave it correctly, ask whether they can do better; if the complexity they gave is wrong for their code, ask them about the "
                "worst case. If it's clear and specific, acknowledge it in a few neutral words and let them keep going.")
    if trigger == "nudge":
        return ("The candidate has gone quiet for a couple of minutes without saying, typing, or running anything. Check in the way an interviewer would: ask "
                "where they are or what they're thinking, in one short question. Don't give a hint.")
    if trigger == "debug":
        failing = ", ".join(f.get("name", "") for f in (state.get("last_test_run") or {}).get("failing", [])[:3])
        return (f"The same tests have kept failing for a few minutes{f' ({failing})' if failing else ''}. Don't point out the bug or how to fix it. Suggest "
                "one way to find it themselves, such as tracing their code by hand on the smallest failing input and saying what each step does.")
    if trigger == "optimize":
        return ("Their solution now works on the example, but it's slower than the target (see where things stand). Ask for its time complexity, in one short "
                "question. After they answer, you'll push for better." if stage == "main" else
                "Their follow-up now works on the example, but each call is slower than the target. Ask what one call costs as the number of waiting days "
                "grows, in one short question.")
    if trigger == "verify":
        return ("They said they're done coding, but their code doesn't work on every input yet. Don't say which input or why. Before you move on, ask them to "
                "test it on the example and one edge case, or to trace it by hand.")
    if trigger == "hint" and hint and hint.get("repeat"):
        return (f"They're still stuck after your last hint ({hint['text']}). Put the same idea another way, ideally as a question about their own code, and "
                "go no further." if stuck else
                f"The candidate asked for another hint without trying anything since your last one ({hint['text']}). Say you'd like to see them try that "
                "first, and ask what they're thinking.")
    if trigger == "hint" and hint:
        return (f"The candidate seems stuck: no progress for a few minutes, even after you checked in. Step in with a small nudge, the way an Amazon "
                f"interviewer does, starting with something like \"Let me give you a small hint.\" Go no further than this:\n{hint['text']}" if stuck else
                "The candidate asked for a hint. Give it the way an Amazon interviewer would: short and neutral, connected to where they are, ideally as a "
                f"question about their own code, going no further than this:\n{hint['text']}")
    if trigger == "hint":
        return "They've had every hint. Say you'd like to see how they'd take it from here, and ask what they'd try."
    if trigger == "message":
        return (f"The candidate says: \"{message}\"\nIf it's a question about the requirements, answer it from the facts. Otherwise respond as the "
                "interviewer would, with at most one question, and without teaching or giving away the approach.")
    return None


def build_prompt(interview: Interview, state: Dict[str, Any], workspace: Path, elapsed: float, phase: str,
                 trigger: str, message: str = "", hint: Optional[Dict[str, Any]] = None) -> str:
    """Everything the coach or interviewer needs for one reply, kept within the bridge's limits. In an Amazon final
    round's coding part, the interviewer questions the candidate's choices as they code (ROLE_AMAZON_CODING). In the
    coding round, it also pushes for a faster version, gives hints, and helps when you're stuck (ROLE_AMAZON_CODING_ROUND)."""
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
        tests = "The candidate hasn't run the tests yet."
    clarifications = "\n".join(f"- {e['topic']}: {e['answer']}" for e in interview.clarifications())
    hints = interview.hints()
    hint_ladder = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(hints))
    used = len(state.get("hints", []))
    coach = state.get("mode") == "coach"
    you = "Coach" if coach else "Interviewer"
    # The clock as an interviewer keeps it: time left in this phase, and how long they've been coding.
    end = next((p["end"] for p in interview.phases() if p["name"] == phase), None)
    timing = f" (about {max(0, round(end - elapsed / 60))} minutes left in it)" if end is not None else ""
    first_edit = (state.get("coding") or {}).get("first_edit")
    if first_edit is not None:
        timing += f". They started coding at minute {first_edit / 60:.0f}, {max(0, round((elapsed - first_edit) / 60))} minutes ago"
    history: List[str] = []
    events = [(q["at"], q) for q in state.get("questions", [])] + [(s["at"], {"spoken": s["text"]}) for s in state.get("spoken", [])]
    for _, item in sorted(events, key=lambda pair: pair[0])[-24:]:
        if "spoken" in item:
            history.append(f"Candidate (thinking aloud): {item['spoken']}")
        elif item.get("source") == "interviewer":
            history.append(f"{you}: {item['answer']}")
        else:
            history.append(f"Candidate: {item['question']}")
            history.append(f"{you}: {item['answer']}")
    conversation = "\n".join(history) or "(nothing yet)"
    followups = "\n".join(f"- {q}" for q in interview.followups())
    coding_round = interview.meta.get("format") == "amazon-coding"
    amazon = interview.meta.get("format") in ("amazon-final", "amazon-coding") and not coach
    revealed = state.get("change_revealed_at") is not None
    reference, change = interview.approach(), ""
    if amazon:  # no approach file: the guide's notes on the problem, and on its follow-up once the candidate has it
        reference = "\n\n".join(part for part in (interview.guide_section("Coding problem"),
                                                  interview.guide_section("Pushing for the optimal") if coding_round else "",
                                                  interview.guide_section("Follow-up at") if revealed else "") if part)
        change = ("\n" + (f"The interviewer's follow-up, now shown to the candidate:\n{interview.change_request()}" if revealed
                          else "The interviewer adds a follow-up later. Don't mention or hint at it before then.") + "\n")
    before_code = (state.get("coding") or {}).get("first_edit") is None and not revealed and phase == interview.phases()[0]["name"]
    wrapping = next((p.get("kind") for p in interview.phases() if p["name"] == phase), None) == "wrap"
    round_ask = _round_ask(state, trigger, message, hint, before_code, wrapping) if coding_round else None
    if coding_round:   # its hints are the ones for the part they're on, and only when one is due
        stage_hints = interview.followup_hints() if revealed and interview.followup_hints() else hints
        hints = stage_hints if trigger == "hint" else []
        hint_ladder = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(hints))
        used = sum(1 for h in state.get("hints", []) if h.get("stage", "main") == ("followup" if revealed and interview.followup_hints() else "main"))

    if round_ask:
        ask = round_ask
    elif amazon and trigger == "thinking":
        ask = (f"The candidate is narrating while they work: \"{message}\". Check their understanding: ask one question about a choice they just described or wrote "
               "(why that data structure, the cost of that step, the overall complexity, why not a simpler option, or what their code does on a specific edge case). "
               "Tie it to their actual words or code.")
    elif amazon and trigger == "code":
        ask = (f"The candidate just typed these lines without explaining them:\n{message}\n"
               "Ask one question that checks they understand what they wrote: what a specific variable or line is for, why that structure, or what it costs. Name it.")
    elif amazon and trigger == "answer":
        ask = (f"The candidate just answered your last question: \"{message}\". If the answer is vague, skips the why, or doesn't match their code, follow up once on "
               "the same point (ask them to be specific, or to trace it on a small example). If it's clear and specific, acknowledge it in a few neutral words and let them keep going.")
    elif amazon and trigger == "nudge":
        ask = "The candidate has gone quiet for a few minutes. Ask them to talk you through what they're doing right now, or about the last thing they wrote."
    elif trigger == "hint" and hint and hint.get("repeat"):
        ask = (f"The candidate asked for a hint again, but hasn't said, tried, or changed anything since your last hint (level {hint['level']}: {hint['text']}). "
               "Don't give a bigger hint. Talk with them: ask warmly which part is unclear or what they'd try first, and put the same idea another way, ideally as a question about their own code." if coach
               else f"The candidate asked for another hint without trying anything since your last one ({hint['text']}). As the interviewer, say you'd like to see them try that first, and ask what they're thinking.")
    elif trigger == "hint" and hint:
        ask = (f"The candidate asked for a hint. Make it part of the conversation, not a canned line: briefly connect to what they've said or written, then give the next step, ideally as a guiding question about their code. "
               f"Go no further than this level ({hint['level']} of {hint['total']}):\n{hint['text']}" if coach
               else f"The candidate asked for a hint. As the interviewer, give one short, neutral sentence that connects to where they are, going no further than this:\n{hint['text']}")
    elif trigger == "hint":
        ask = ("The candidate asked for another hint, but they've had all three. Encourage them, point at the single most important next step in their code, and mention they can open Show the approach in the menu." if coach
               else "The candidate asked for another hint, but they've had all three. Say neutrally that you'd like to see how they'd take it from here, and ask what they're thinking.")
    elif trigger == "tests":
        ask = ("The candidate just ran the tests (results above). React briefly: if something failed, help them see why with one question; if everything passed, say so and ask about one edge case or the complexity." if coach
               else "The candidate just ran the tests (results above). Say at most one short, neutral sentence, such as asking what the result tells them. Don't explain failures.")
    elif trigger == "nudge":
        ask = ("The candidate has been quiet for a couple of minutes while coding. Check in warmly with one short question about where they are or what they're stuck on." if coach
               else "The candidate has been quiet for a while. As the interviewer, ask them to talk you through what they're doing right now.")
    elif trigger == "thinking":
        ask = (f"The candidate just thought aloud: \"{message}\". If it's a good moment, respond briefly (affirm, or ask one guiding question). Don't interrupt their flow with a long reply." if coach
               else f"The candidate just thought aloud: \"{message}\". If it's natural, respond as an interviewer would: a brief acknowledgement or one probing question (complexity, an edge case, a tradeoff). Don't evaluate or correct it.")
    else:
        ask = f"The candidate says: \"{message}\""

    hint_section = (f"Hint ladder (for you only; give a level only when asked for a hint; {used} of {len(hints)} used so far):\n{hint_ladder}\n\n" if hints else "")
    standing = f"\nWhere things stand (for you only):\n{_round_status(interview, state)}\n" if coding_round else ""
    return f"""Your role:
{ROLE_COACH if coach else ROLE_AMAZON_CODING_ROUND if coding_round and amazon else ROLE_AMAZON_CODING if amazon else ROLE_REAL}

Problem the candidate is solving:
{_problem_text(interview)}
{change}
Facts about the problem (use these to answer requirement questions):
{clarifications}

Reference approach (for you only; {"only explain it if they give up and ask for the answer" if coach else "never reveal it"}):
{reference}

{hint_section}Follow-up questions for the wrap-up (ask one at a time, only in the last phase):
{followups or '- (none)'}

Session: minute {elapsed / 60:.0f} of {interview.meta.get('duration_minutes', 35)}, phase "{phase}"{timing}. If time is running short, say so plainly and help them prioritize, as an interviewer keeping the clock would.
{standing}

Candidate's current code:
{chr(10).join(code_parts) or '(empty)'}

{tests}

Conversation so far (most recent last):
{conversation}

Now: {ask}

Reply as the {you.lower()}, in {"one to three" if coach else "one or two"} short spoken sentences."""[-110_000:]


def _resume_conversation(state: Dict[str, Any]) -> str:
    """The whole conversation, oldest first: the interviewer's lines and the candidate's answers."""
    # Interviewer lines and exchanges come from the questions list; the candidate's spoken and scripted-round answers are marked "said".
    events = [((q["at"], q.get("n", 0)), q) for q in state.get("questions", [])] + [((s["at"], s.get("n", 0)), {"said": s["text"]}) for s in state.get("spoken", [])]
    events += [((part["at"], part.get("n", 0)), {"said": part["text"]}) for answer in state.get("behavioral", {}).get("answers", []) for part in answer.get("parts", [])]
    lines: List[str] = []
    for _, item in sorted(events, key=lambda pair: pair[0]):
        if "said" in item:
            lines.append(f"Candidate: {item['said']}")
        elif item.get("source") == "interviewer":
            lines.append(f"Interviewer: {item['answer']}")
        else:
            lines.append(f"Candidate: {item['question']}")
            lines.append(f"Interviewer: {item['answer']}")
    return "\n".join(lines)


def principles(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """This session's Leadership Principles questions, in the order they're asked."""
    return [item for item in state.get("behavioral", {}).get("plan", []) if item.get("lp")]


def section_started(state: Dict[str, Any]) -> bool:
    return any(q.get("section") for q in state.get("questions", []))


def _section_pacing(state: Dict[str, Any], asked: List[Dict[str, Any]], minutes: float, phase: Optional[Dict[str, Any]]) -> str:
    """Which principles question the interviewer is on, and when to move to the next, from when the section really started."""
    from .resume import closest_principle
    opened = [q for q in state.get("questions", []) if q.get("section")]
    if not opened:
        return "start the section with question 1."
    start = opened[0]["at"] / 60
    end = phase["end"] if phase and phase.get("principles") else start + 8
    on = 0
    for q in state.get("questions", []):
        if q["at"] / 60 >= start:
            on = max(on, closest_principle(q.get("answer", ""), asked) or 0)
    due = start + (end - start) * (on + 1) / len(asked)
    if on + 1 < len(asked) and minutes >= due:
        return f"time's up for question {on + 1}. Move on now with a short transition and ask question {on + 2}."
    if on + 1 < len(asked):
        return f"you're on question {on + 1}. Ask a follow-up about their story, and move to question {on + 2} by minute {due:.0f}."
    return f"you're on the last question ({on + 1}). Ask follow-ups about their story until the section's time is up."


def _plain_question(item: Dict[str, Any]) -> str:
    from .resume import LP_INTRO
    return item["question"].replace(LP_INTRO, "")


def build_resume_prompt(interview: Interview, state: Dict[str, Any], resume_text: str, elapsed: float, trigger: str, message: str = "",
                        start_section: bool = False) -> str:
    """One turn of the résumé deep dive: the résumé, the plan and where the clock is, and everything said so far."""
    minutes = elapsed / 60
    duration = interview.meta.get("duration_minutes", 30)
    phases = interview.phases()
    current = next((p for p in phases if p["start"] <= minutes < p["end"]), None)
    lp_phase = next((p for p in phases if p.get("principles")), None)
    if lp_phase and section_started(state) and minutes < lp_phase["end"]:
        current = lp_phase  # the section opened a little early; it runs until its end, not the deep dive's
    plan = "\n".join(f"- {p['start']}–{p['end']} min: {p['name']}. {p.get('goal', '')}" for p in phases)
    if current is None:
        pacing = "Time's up. Thank them warmly in one or two sentences and say you'll be in touch, then stop asking questions."
    else:
        left = current["end"] - max(minutes, current["start"])
        pacing = f"You're in \"{current['name']}\" with about {max(0, round(left))} minute(s) left in it. {current.get('goal', '')}"
        if left < 1 and current is not phases[-1]:
            following = phases[phases.index(current) + 1]
            pacing += f" Wrap this part up and move to \"{following['name']}\" now."
    asked = principles(state)
    in_section = bool(current and current.get("principles")) or start_section
    section = ""
    if asked and in_section:
        listed = "\n".join(f"{i + 1}. [{item['lp']}] {_plain_question(item)}\n   Follow-ups to draw on: {' / '.join(item.get('followups', []))}\n   Listen for: {item.get('look_for', '')}"
                            for i, item in enumerate(asked))
        section = f"""
Leadership Principles section (its own part of the interview). This session's questions, asked in order, in your own words, without naming the principle:
{listed}
Spend about half the section on each question. On each, ask two or three follow-ups tied to their story: what they did themselves, why, the result (with a number if they have one), and what they learned. The technical deep dives are over: keep these follow-ups on the story, not on implementation details. A vague or hypothetical answer gets "Can you think of a specific time?"
Right now: {_section_pacing(state, asked, minutes, current)}
"""
    name = interview.meta.get("interviewer_name", "Sam")
    if start_section and asked:
        ask = (f"The candidate just said: \"{message}\"\nNow start the Leadership Principles section, which should feel like its own part of the interview. "
               "In at most three short sentences: acknowledge their answer in a few words, say you're switching to a couple of behavioral questions based on "
               "Amazon's Leadership Principles and that they should use a specific example and say what they did themselves, then ask the first question "
               f"in your own words: \"{_plain_question(asked[0])}\"")
    elif trigger == "open":
        ask = "You've just greeted them (above). Ask them to walk you through their background in two or three minutes. You may mention one thing from their résumé to show you've read it."
    elif trigger == "nudge":
        ask = "They've been quiet for a while. Gently check whether they'd like you to rephrase the question, or ask a simpler one."
    else:
        ask = f"The candidate just said: \"{message}\"\nReply as the interviewer: a brief acknowledgement if natural, then your next question (a follow-up or the next topic, as the plan and clock say)."
    conversation = _resume_conversation(state)[-60_000:] or "(nothing yet)"
    return f"""Your role (your name is {name}):
{ROLE_RESUME}

The candidate's résumé:
<<<
{resume_text[:14_000]}
>>>

Interview plan ({duration} minutes):
{plan}

Clock: minute {minutes:.0f} of {duration}. {pacing}
{section}
Conversation so far (oldest first):
{conversation}

Now: {ask}

Reply as {name}, the interviewer, in {"up to three" if start_section else "one or two"} short spoken sentences."""[-110_000:]


def build_behavioral_prompt(interview: Interview, state: Dict[str, Any], resume_text: str, elapsed: float, step: Dict[str, Any],
                            opening: bool = False) -> str:
    """One Leadership Principles prompt in the interviewer's own words: the planned step (a follow-up, or the next
    question), the story so far, the résumé if there is one, and everything said before it. `state` is from before the
    step, and `opening` means the candidate just finished introducing themselves, ahead of the clock."""
    minutes = elapsed / 60
    duration = interview.meta.get("duration_minutes", 45)
    asked = state.get("behavioral", {}).get("plan") or interview.behavioral()
    listed = "\n".join(f"{i + 1}. [{item.get('lp') or ('Résumé deep dive' if item.get('kind') == 'depth' else 'Behavioral')}] {_plain_question(item)}" for i, item in enumerate(asked))
    deep_dive = any(item.get("kind") == "depth" for item in asked)   # the full Amazon interview opens with one from the résumé
    section = next((p for p in interview.phases() if p.get("kind") == "behavioral"), None)
    clock = f"minute {minutes:.0f} of {duration}" + (f"; the questions run until minute {section['end']}" if section else "")
    if step.get("seconds_left") is not None:
        left = step["seconds_left"] / 60
        clock += (f"; about {left:.0f} minute{'' if round(left) == 1 else 's'} left for this question, so keep it moving" if left >= 1
                  else "; this question's time is nearly up, so keep this short")
    index, item = step["index"], step["item"]
    answers = state.get("behavioral", {}).get("answers", [])
    if step["kind"] == "behavioral:followup":
        story = " ".join(part["text"] for part in answers[-1]["parts"])[-4000:] if answers else ""
        others = " / ".join(item.get("followups", [])[step["followup"] + 1:]) or "(none: ask what they learned or would do differently)"
        vague = ("If they stay high-level, ask exactly how their part works." if item.get("kind") == "depth"
                 else "If the story is vague or isn't about one real time, ask for a specific example.")
        ask = (f"They're answering question {index + 1}. Their story so far: \"{story or '(nothing yet)'}\"\n"
               f"Ask the next follow-up. The planned one is: \"{step['text']}\" Ask it in your own words, tied to a specific detail of their story. "
               f"If they've already answered it, ask one they haven't covered instead: {others}. {vague}")
    else:
        question = _plain_question(item)
        if opening and index == 0:
            ask = ("They just finished introducing themselves (their last lines above). Acknowledge it in a few neutral words (not \"nice\" or \"great\"), naming one specific thing they said, "
                   f"say you'll {'start with something from their résumé' if item.get('kind') == 'depth' else 'move on to some questions about situations they have been in'}, "
                   f"then ask question 1 in your own words: \"{question}\"")
        elif index == 0:
            ask = f"You've just told them you're starting the questions. Ask question 1 in your own words, without another greeting: \"{question}\""
        elif step.get("hurried"):
            ask = (f"Their story for question {index} has used its share of the time, so you're moving on before the remaining follow-ups. Say so in a few "
                   f"words, as interviewers do (\"In the interest of time, let's move on.\"), then ask question {index + 1} in your own words: \"{question}\"")
        else:
            ask = (f"They've finished their story for question {index}. Move on with a short, natural transition (a few words, without judging their answer), "
                   f"then ask question {index + 1} in your own words: \"{question}\"")
        if resume_text.strip() and item.get("kind") != "depth":
            ask += (" If one experience on their résumé clearly fits, you may suggest it as a starting point (\"maybe from your internship at X?\") but let them "
                    "pick the story. Do that for at most half of the questions, and only name things that are really on the résumé.")
    note = ("the deep-dive question is about something on it; dig into how it works, but don't quiz them on the rest" if deep_dive
            else "so you know their background (don't quiz them on it)")
    background = (f"The candidate's résumé, {note}:\n<<<\n{resume_text[:14_000]}\n>>>" if resume_text.strip()
                  else "The candidate hasn't added a résumé.")
    conversation = _resume_conversation(state)[-20_000:] or "(nothing yet)"
    return f"""Your role:
{ROLE_BEHAVIORAL}

{background}

This session's questions, in order (the principle in brackets is for you only; never say it):
{listed}

Clock: {clock}.

Conversation so far (oldest first):
{conversation}

Now: {ask}

Reply as the interviewer, in {"up to three" if opening else "one or two"} short spoken sentences with exactly one question."""[-110_000:]


def build_debrief_prompt(interview: Interview, state: Dict[str, Any], resume_text: str, report: Dict[str, Any]) -> str:
    """The interviewer's written notes after the interview, with the automatic scores as a starting point."""
    scores = "\n".join(f"- {s['label']}: {s['score'] if s['score'] is not None else 'not observed'}/5" for s in report.get("scores", []))
    return f"""Write your notes on this résumé deep dive for the candidate.

Their résumé:
<<<
{resume_text[:14_000]}
>>>

Transcript (oldest first):
{_resume_conversation(state)[-70_000:] or "(nothing was said)"}

Leadership Principles questions asked in their own section, near the end:
{chr(10).join(f"- {item['lp']}: {_plain_question(item)} (listen for: {item.get('look_for', '')})" for item in principles(state)) or "- (none)"}

Automatic heuristic scores, for reference (you may disagree):
{scores}

Rules for evidence: quote only what the candidate said (the "Candidate:" lines). Never present résumé text as something they said; refer to it as "your résumé says". If the transcript is short, say how far the interview got and keep each section brief instead of padding it.

Write these sections, in Markdown, about 250–400 words in all (less for a short transcript):
## Overall
Two or three sentences: how it went and whether you'd push to move them forward, and why.
## What came across well
Two to four bullets, each quoting them.
## What to work on
Three bullets: specific, each with a quote and what a stronger answer would have included.
## Leadership Principles
One or two sentences per principle asked: how well the story showed it (STAR, what they did themselves, a result, what they learned), quoting them.
## Résumé claims to be ready for
Items on their résumé that they didn't explain well or weren't asked about yet, and the question you'd expect for each.
## Practice next
One concrete exercise for before their next interview."""


def _learning_ask(kind: str, part: int, trigger: str, message: str, hint: Optional[Dict[str, Any]]) -> str:
    """What the learning round's interviewer is asked to do this turn, by the part of the round and what happened."""
    stuck = bool(hint and hint.get("reason") == "stuck")
    if kind == "over":
        return (f"The round's time is up. The candidate says: \"{message}\"\nIf it's a question for you, answer it briefly. "
                "Otherwise say you're at time and thank them. Don't ask anything new, and don't help with the code.")
    if trigger == "hint" and hint and hint.get("repeat"):
        return (f"They're still stuck after your last hint ({hint['text']}). Put the same idea another way, ideally as a pointer to the docs, and go no further." if stuck
                else f"They asked for another hint without trying your last one ({hint['text']}). Say you'd like to see them try that first, and ask what they'd do.")
    if trigger == "hint" and hint:
        return ((f"The candidate seems stuck on part {part}: no progress for a few minutes, even after you checked in. Step in with a small nudge, starting with "
                 f"something like \"Let me point you somewhere.\" Go no further than this:\n{hint['text']}") if stuck else
                f"The candidate asked for a hint on part {part}. Give it the way a teammate would, ideally as a pointer to the docs or a question, going no further than this:\n{hint['text']}")
    if trigger == "hint":
        return "They've had every hint for this part. Say you'd like to see how they'd take it from here, or suggest they move on to the next part."
    if trigger == "nudge":
        return f"They've gone quiet on part {part} for a couple of minutes. Check in: ask where they are or what they're looking at, in one short question. Don't give a hint."
    if trigger == "debug":
        return (f"The same tests for part {part} have kept failing for a few minutes. Don't say what's wrong. Suggest one way to find it themselves: rereading the docs "
                "section for the relay call involved, or printing what a handle's state or an outcome holds.")
    if trigger == "verify":
        return f"They asked to move on, but the tests for part {part} fail. Ask them to run the tests and tell you what they show. Don't say what's wrong."
    if trigger == "code":
        return (f"The candidate just typed these lines without explaining them:\n{message}\n"
                "Ask one question that checks they understand how a relay call there behaves: what it returns, what it raises, or when it runs. Name the call.")
    if kind == "learn":
        return (f"While reading, the candidate says: \"{message}\"\nIf it's a question the docs answer, answer it in a sentence and name the section. If the docs don't "
                "cover it, answer from the facts. If they're explaining what they've read, check it against the docs: if it's right, say so in a word and let "
                "them keep reading, or ask one understanding question from your list that they haven't covered; if it's wrong or vague, ask a question that "
                "sends them back to the right section, without giving the answer. Reading time is only five minutes, so keep it short. Don't give them the "
                "first part yet.")
    if kind == "wrap":
        return (f"It's the wrap-up, and the candidate says: \"{message}\"\nIf it's a question for you, answer it briefly, as an engineer on the deployment would. "
                "Otherwise ask the next follow-up question from your list that you haven't asked, one at a time; once you've asked them, ask what questions they have for you.")
    return (f"The candidate is working on part {part} and says: \"{message}\"\nIf it's a question, answer it: name the docs section if the docs answer it, or use the facts. "
            "If they're planning, make sure they've said how they'll use relay, and if the plan relies on something relay doesn't do, ask about that exact behavior. "
            "Otherwise ask one question that checks they understand the relay call they're using, or tell them to go ahead.")


def build_learning_prompt(interview: Interview, status: Dict[str, Any], workspace: Path, trigger: str, message: str = "",
                          hint: Optional[Dict[str, Any]] = None) -> str:
    """One turn of the Palantir learning round: the library's docs, the parts so far, the facts, the candidate's code
    and tests, and the conversation, with what the interviewer should do now."""
    state, elapsed = status["state"], status["elapsed"]
    phases, index = status["phases"], status["phase"]
    phase = phases[index] if index < len(phases) else None
    kind = (phase or {}).get("kind", "over")
    parts, revealed = interview.parts(), state.get("parts") or []
    part = len(revealed)
    code = []
    for name in interview.meta.get("editor_files", []):
        try:
            code.append(f"--- {name} ---\n{(workspace / name).read_text(encoding='utf-8')[:12000]}")
        except OSError:
            pass
    run = state.get("last_test_run")
    tests = (f"Latest test run at minute {run['at'] / 60:.0f}: {run['passed']} passed, {run['failed']} failed, {run['errors']} errors."
             + "".join(f"\n- {c['name']}: {c['message']}" for c in run.get("failing", [])[:5])) if run else "They haven't run the tests yet."
    history: List[str] = []
    events = [(q["at"], q.get("n", 0), q) for q in state.get("questions", [])] + [(s["at"], s.get("n", 0), {"spoken": s["text"]}) for s in state.get("spoken", [])]
    for _, _, item in sorted(events, key=lambda e: (e[0], e[1]))[-30:]:
        if "spoken" in item:
            history.append(f"Candidate: {item['spoken']}")
        elif item.get("source") == "interviewer":
            history.append(f"Interviewer: {item['answer']}")
        else:
            history.append(f"Candidate: {item['question']}")
            history.append(f"Interviewer: {item['answer']}")
    facts = "\n".join(f"- {e['topic']}: {e['answer']}" + (f" (the docs cover this, in section {e['docs']})" if e.get("docs") else " (not in the docs)")
                      for e in interview.clarifications())
    shown = "\n\n".join(f"{p['text'].strip()}" + (" [done]" if revealed[i]["done_at"] is not None else " [they're on this part]")
                        for i, p in enumerate(parts[:part])) or "(none yet: they're still reading)"
    end = status["bounds"][index][1] if index < len(status["bounds"]) else None
    on_part = f" They've been on part {part} for {max(0, round((elapsed - revealed[-1]['at']) / 60))} minutes." if revealed else ""
    used = sum(1 for h in state.get("hints", []) if h.get("stage") == f"part{part}")
    standing = (f"Minute {elapsed / 60:.0f} of {interview.meta.get('duration_minutes', 60)}, in \"{(phase or {}).get('name', 'overtime')}\""
                + (f", about {max(0, round(end - elapsed / 60))} minutes left in it" if end is not None else "") + "."
                + (f" Part {part} of {len(parts)}.{on_part} Hints on this part: {used} of {len(parts[part - 1]['hints'])}." if 0 < part <= len(parts) else ""))
    return f"""Your role:
{ROLE_PALANTIR_LEARNING}

The candidate's task (they can see this):
{interview.task().strip()}

relay's docs (they have these in the Docs tab):
<<<
{interview.docs()}
>>>

The parts so far (each was shown to them when it came):
{shown}

Facts (use these to answer; say which docs section when the docs cover it):
{facts}

Your understanding questions, for while they read (one at a time; for you only, with the answers):
{interview.guide_section("Questions to check understanding")}

Notes on each part (for you only; never reveal them):
{interview.guide_section("The parts")}

Follow-up questions for the wrap-up (one at a time, only if the parts end with time to spare):
{chr(10).join(f"- {q}" for q in interview.followups())}

Where things stand: {standing}

Their code:
{chr(10).join(code) or "(empty)"}

{tests}

Conversation so far (most recent last):
{chr(10).join(history) or "(nothing yet)"}

Now: {_learning_ask(kind, part, trigger, message, hint)}

Reply as the interviewer, in one or two short spoken sentences."""[-110_000:]


def build_learning_debrief_prompt(interview: Interview, state: Dict[str, Any], report: Dict[str, Any], diff: str) -> str:
    """The learning round's interviewer's notes, from the transcript, the parts, the tests, and the code."""
    scores = "\n".join(f"- {s['label']}: {s['score'] if s['score'] is not None else 'not observed'}/5" for s in report.get("scores", []))
    parts = interview.parts()
    progress = "\n".join(f"- {parts[i]['title']}: shown at minute {p['at'] / 60:.0f}, " + ("not finished" if p["done_at"] is None else
                         f"{'moved on without passing' if p['skipped'] else 'tests passed'} at minute {p['done_at'] / 60:.0f}")
                         for i, p in enumerate(state.get("parts", [])) if i < len(parts)) or "- They never got to the first part."
    help_lines = "\n".join(f"- minute {h['at']:.0f}: {h['text']}" for h in report.get("help") or []) or "- none"
    plan = {p.get("kind"): p["end"] - p["start"] for p in interview.phases()}
    return f"""Write your notes on this Learning interview for the candidate.

relay's docs, to check their claims against:
<<<
{interview.docs()[:9000]}
>>>

The parts and how far they got ({interview.meta.get('duration_minutes', 60)} minutes in all: about {plan.get('learn')} to read, then {plan.get('coding')} for the parts, where two parts is a solid pace):
{progress}

When you stepped in:
{help_lines}

Grading tests after they submitted: {report['tests']['grading']['passed']} of {report['tests']['grading']['total']} passed. Missed: {"; ".join(report.get("missed_cases", [])[:8]) or "none"}.

Their changes (diff against the starter):
<<<
{diff[:20000] or "(no changes)"}
>>>

Transcript (oldest first):
{_resume_conversation(state)[-60_000:] or "(nothing was said)"}

Automatic heuristic scores, for reference (you may disagree):
{scores}

Rules for evidence: quote only what the candidate said (the "Candidate:" lines) or wrote in their code. If the transcript is short, say how far the interview got and keep each section brief instead of padding it.

Write these sections, in Markdown, about 250–400 words in all (less for a short transcript):
## Overall
Two or three sentences: how fast you got productive with relay, whether the interviewer would move you forward, and why.
## How you learned relay
What you understood correctly and what you got wrong, each with a quote, and whether you read before coding.
## Your questions
Which questions were purposeful, which the docs already answered, and the important one you did or didn't ask.
## Building it
How you worked through the parts: small steps, tests, how you used relay's calls, where you got stuck.
## What to work on
Three bullets, each specific, with what a stronger candidate would have done.
## Practice next
One concrete exercise for before their next learning round."""


def stream(prompt: str, timeout: int = 90, system: str = SYSTEM) -> Iterator[str]:
    """Streams the coach's reply from the bridge, chunk by chunk. Anything but the shared system prompt gets a one-off process."""
    body = json.dumps({"model": MODEL, "system": system, "prompt": prompt, **({} if system == SYSTEM else {"warm": False})}).encode("utf-8")
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
