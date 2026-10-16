"""The offline interviewer: answers clarification questions from the interview's answer key.

It only answers what is asked, and never volunteers planted defects. Questions it
has no answer for get the standard interview reply: state an assumption and go on.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

from .catalog import Interview

NO_ANSWER = (
    "I don't have a specific answer for that. Make a reasonable assumption, say it out loud "
    "(write it in Assumptions), and keep going. If it turns out to matter, we can revisit it."
)


def _matches(keyword: str, text: str) -> bool:
    keyword = keyword.lower()
    if re.fullmatch(r"[\w']+", keyword):
        return re.search(rf"(?<![\w']){re.escape(keyword)}", text) is not None  # word start, so "retry" also matches "retries"
    return keyword in text


def best_entry(entries: List[Dict[str, Any]], text: str) -> Dict[str, Any]:
    text = text.lower()
    best, best_score = None, 0
    for entry in entries:
        score = sum(1 for keyword in entry.get("keywords", []) if _matches(keyword, text))
        if score > best_score:
            best, best_score = entry, score
    return best or {}


def answer(interview: Interview, question: str, change_revealed: bool) -> Dict[str, Any]:
    entry = best_entry(interview.clarifications(), question)
    if not entry:
        return {"topic": None, "answer": NO_ANSWER, "matched": False}
    text = entry.get("answer_after_change") if change_revealed and entry.get("answer_after_change") else entry["answer"]
    return {"topic": entry["topic"], "answer": text, "matched": True}


def topics_covered(interview: Interview, questions: List[Dict[str, Any]], stated: str) -> Dict[str, List[str]]:
    """Important topics the candidate asked about, or covered as a stated assumption, and the ones they missed."""
    asked = {q.get("topic") for q in questions if q.get("topic")}
    stated = stated.lower()
    covered, missed = [], []
    for entry in interview.clarifications():
        if not entry.get("important"):
            continue
        hit = entry["topic"] in asked or sum(1 for k in entry.get("keywords", []) if _matches(k, stated)) >= 2
        (covered if hit else missed).append(entry["topic"])
    return {"covered": covered, "missed": missed}


def interviewer_packet(interview: Interview) -> str:
    """A prompt for a separate Claude conversation that plays the interviewer. It contains the answers."""
    if interview.meta.get("format", "").startswith("amazon"):
        return _amazon_packet(interview)
    qa = "\n".join(f"- {e['topic']}: {e['answer']}" + (f" (After the change: {e['answer_after_change']})" if e.get("answer_after_change") else "") for e in interview.clarifications())
    minutes = interview.meta.get("change_at_minutes", 30)
    return f"""You are the interviewer in a 60-minute practice software engineering interview. The candidate is practicing; be realistic, concise, and fair.

Rules:
- You are not the candidate's coding assistant. Do not write code for them, and do not reveal the planted defects, the reference solution, or grading tests.
- Answer clarification questions using the answer key below. If something is not covered, tell them to state a reasonable assumption.
- Follow the timeline: 0-5 clarify, 5-15 explore and explain a plan, 15-40 implement with AI assistance, 40-50 edge cases and the AI patch review, 50-60 explanation and tradeoffs.
- At minute {minutes}, or when the candidate tells you it is minute {minutes}, present the requirement change below, word for word. Not before.
- Ask one follow-up question at a time. Ask them to explain decisions and how they verified the assistant's output.
- When the candidate says they are done, evaluate them with the rubric: score each area 1-5 or "not observed" when there is no evidence, cite specific evidence, list missed cases and questionable assumptions, give three concrete improvements, and suggest one short follow-up exercise for the weakest observed skill. Using the coding assistant a lot is not a negative.

Start by greeting the candidate and asking if they have read the task.

=== Candidate task (they can see this) ===
{interview.task()}

=== Requirement change (reveal at minute {minutes}) ===
{interview.change_request()}

=== Clarification answer key (interviewer only) ===
{qa}

=== Interviewer guide (interviewer only) ===
{interview.guide()}

=== Rubric ===
{interview.rubric()}
"""


# What the interviewer says, unprompted, as the session moves along.
CUES = {
    "start": "Hi, I'll be your interviewer today. Take a few minutes to read the problem, and ask me anything that's unclear before you start.",
    "plan": "Let's move on. Walk me through the code and tell me your plan before you start changing things.",
    "build": "Sounds good. Go ahead and start implementing. Use your assistant however you like, and talk me through what you're doing.",
    "change": "Quick change from the product side. I've put the new requirement in the Change tab and in CHANGE_REQUEST.md in your workspace. Take a look and tell me how it affects your design.",
    "edge": "Let's look at edge cases now. There's also a patch an AI assistant proposed in the patch review folder. Tell me whether you'd merge it.",
    "explain": "We have about ten minutes left. Walk me through your final implementation and the tradeoffs you made.",
}
PLAN_PROMPTS = [
    "Which file do you think the problem is in, and why?",
    "What would you change first?",
    "How will you know your fix works?",
]
CLOSING_PROMPTS = [
    "How did you check what your coding assistant gave you?",
    "What would you do differently with more time?",
]


def cues_for(interview: Interview) -> Dict[str, str]:
    """The interviewer's scripted lines: the defaults, plus or replaced by the interview's own "cues"."""
    return {**CUES, **interview.meta.get("cues", {})}


def prompts_for(interview: Interview, phase: str) -> List[str]:
    if phase == "plan":
        return interview.meta.get("plan_prompts", PLAN_PROMPTS)
    return interview.followups() + interview.meta.get("closing_prompts", CLOSING_PROMPTS)


def _amazon_packet(interview: Interview) -> str:
    from .catalog import leadership_bank
    focus = interview.meta.get("behavioral", {}).get("focus")
    bank = [entry for entry in leadership_bank() if not focus or entry["lp"] in focus]
    questions = "\n".join(f"- {entry['lp']} (look for: {entry['look_for']})\n" + "\n".join(f"  - {q['q']} Follow-ups: {' / '.join(q['followups'])}" for q in entry["questions"]) for entry in bank)
    qa = "\n".join(f"- {e['topic']}: {e['answer']}" for e in interview.clarifications())
    phases = "\n".join(f"- {p['start']}-{p['end']} min: {p['name']}" for p in interview.phases())
    change = f"=== Follow-up to give at minute {interview.meta['change_at_minutes']} ===\n{interview.change_request()}\n" if interview.meta.get("change_at_minutes") is not None else ""
    count = interview.meta.get("behavioral", {}).get("count", 2)
    return f"""You are an Amazon software engineer interviewing a candidate for an SDE internship in a {interview.meta.get('duration_minutes', 45)}-minute practice round. Be warm but rigorous, like a real Amazon interviewer.

Rules:
- No AI help for the candidate, and you never write code for them or reveal the reference solution or grading tests.
- Follow this timeline:
{phases}
- Ask {count} Leadership Principles questions from different principles in the bank below. After each answer, ask its follow-ups one at a time, and push for specifics: what the candidate personally did, numbers, and what they'd do differently.
- During coding, answer clarifying questions from the answer key, ask about time and space complexity, and ask them to dry-run the example.
- At the end, take their questions about the team, then evaluate: score each area 1-5 or "not observed" (problem understanding, each Leadership Principle asked, problem solving and complexity, correctness and edge cases, testing and dry run, code quality, communication), cite evidence, list missed cases, give three concrete improvements, and one follow-up exercise for the weakest area.

Start by introducing yourself and asking the candidate to introduce themselves.

=== Candidate task (they can see this) ===
{interview.task()}

{change}=== Leadership Principles question bank (interviewer only) ===
{questions}

=== Clarification answer key (interviewer only) ===
{qa}

=== Interviewer guide (interviewer only) ===
{interview.guide()}

=== Rubric ===
{interview.rubric()}
"""
