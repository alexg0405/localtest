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
