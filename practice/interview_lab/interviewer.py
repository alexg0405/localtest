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


FILLERS = re.compile(r"^(?:(?:so|oh|okay|ok|um+|uh+|hmm+|and|also|alright|all right|right|hey|well|yeah|wait|quick question|one more thing)[\s,]+)+", re.I)
ASKS = re.compile(r"^(what|how|why|when|where|which|who|whose|should|shall|can|could|would|will|is|are|am|was|were|do|does|did|have|has|may|might|must|any)\b|\?\s*$"
                  r"|\b(can i|can you|could you|do you|should i|should we|is it|is there|are there|are we|what if|what about|how about|i was wondering|do we need|am i allowed)\b", re.I)


def is_question(text: str) -> bool:
    """A short question for the interviewer, rather than part of an answer (the dashboard's rule, for spoken and typed text)."""
    text = text.strip()
    return len(text.split()) < 20 and bool(ASKS.search(FILLERS.sub("", text).strip()))


def best_entry(entries: List[Dict[str, Any]], text: str) -> Dict[str, Any]:
    text = text.lower()
    best, best_score = None, 0
    for entry in entries:
        score = sum(1 for keyword in entry.get("keywords", []) if _matches(keyword, text))
        if score > best_score:
            best, best_score = entry, score
    return best or {}


COACH_NO_ANSWER = (
    "Good question. I don't have a specific answer for that one, so make a reasonable assumption and say it out loud. "
    "If you're stuck on the approach, ask me for a hint."
)


def answer(interview: Interview, question: str, change_revealed: bool, mode: str = "real") -> Dict[str, Any]:
    from .catalog import concepts
    coach = mode == "coach"
    # The coach also explains general concepts (heaps, BFS, big-O); a real interviewer only clarifies the problem.
    entry = best_entry(interview.clarifications() + (concepts() if coach else []), question)
    if not entry:
        return {"topic": None, "answer": COACH_NO_ANSWER if coach else NO_ANSWER, "matched": False}
    text = entry.get("answer_after_change") if change_revealed and entry.get("answer_after_change") else entry["answer"]
    if coach and entry.get("important"):
        text = "Good question, that's exactly the kind of thing to clarify. " + text
    if entry.get("docs"):   # the learning round: the docs answer it, so say where
        text = f"That's in the docs, in section {entry['docs']}: {text}"
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
    if interview.meta.get("format") == "amazon-coding":
        return _coding_packet(interview)
    if interview.meta.get("format") == "palantir-learning":
        return _learning_packet(interview)
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


def cues_for(interview: Interview, mode: str = "real") -> Dict[str, str]:
    """The interviewer's scripted lines: the defaults, plus or replaced by the interview's own "cues" (or "coach_cues")."""
    lines = {**CUES, **interview.meta.get("cues", {})}
    if mode == "coach":
        lines.update(interview.meta.get("coach_cues", {}))
    return lines


def prompts_for(interview: Interview, phase: str) -> List[str]:
    if phase == "plan":
        return interview.meta.get("plan_prompts", PLAN_PROMPTS)
    return interview.followups() + interview.meta.get("closing_prompts", CLOSING_PROMPTS)


def _coding_packet(interview: Interview) -> str:
    """The coding round's interviewer, for a separate Claude conversation: when to push for a faster version, when to
    help, and the follow-up."""
    qa = "\n".join(f"- {e['topic']}: {e['answer']}" + (f" (After the follow-up: {e['answer_after_change']})" if e.get("answer_after_change") else "") for e in interview.clarifications())
    phases = "\n".join(f"- {p['start']}-{p['end']} min: {p['name']}" for p in interview.phases())
    hints = "\n".join(f"{i}. {text}" for i, text in enumerate(interview.hints(), 1))
    followup_hints = "\n".join(f"{i}. {text}" for i, text in enumerate(interview.followup_hints(), 1))
    return f"""You are an Amazon software engineer running a {interview.meta.get('duration_minutes', 45)}-minute coding interview for an SDE intern candidate. It's only coding: one problem, a follow-up, then questions. Be calm and rigorous, like a real Amazon interviewer.

Rules:
- No AI help for the candidate, and you never write code for them or reveal the reference solution or grading tests.
- Follow this timeline:
{phases}
- Before they code, get an approach and its time and space complexity. If it's slower than the target in the guide, ask once whether they can do better. If they can't find it, let them code what they have.
- Once a slower version works, ask its complexity and push for better without naming the technique.
- If they're stuck (quiet for a couple of minutes, then still nothing after you check in), give the next hint below, as small as will get them moving. Hints count against them, so don't volunteer more.
- At minute {interview.meta.get('change_at_minutes')}, or as soon as their solution is fast and correct, present the follow-up below, word for word.
- In the wrap-up, have them trace the example and give the complexity, ask the follow-up questions in the guide one at a time, then take their questions.
- At the end, evaluate: score each area 1-5 or "not observed" (problem understanding, problem solving and complexity, correctness and edge cases, testing and dry run, code quality, communication), cite evidence, say how much help they needed (hints, the push to optimize), list missed cases, and give three concrete improvements.

Start by introducing yourself, then point them to the problem.

=== Candidate task (they can see this) ===
{interview.task()}

=== Follow-up (reveal later) ===
{interview.change_request()}

=== Hints for the problem (interviewer only, smallest first) ===
{hints}

=== Hints for the follow-up (interviewer only) ===
{followup_hints}

=== Clarification answer key (interviewer only) ===
{qa}

=== Interviewer guide (interviewer only) ===
{interview.guide()}

=== Rubric ===
{interview.rubric()}
"""


def _learning_packet(interview: Interview) -> str:
    """The learning round's interviewer, for a separate Claude conversation: the library's docs, the parts, and what
    to watch for."""
    qa = "\n".join(f"- {e['topic']}: {e['answer']}" + (f" (in the docs: {e['docs']})" if e.get("docs") else " (not in the docs)") for e in interview.clarifications())
    phases = "\n".join(f"- {p['start']}-{p['end']} min: {p['name']}" if p["end"] > p["start"] else f"- If time's left after the parts: {p['name']}"
                       for p in interview.phases())
    parts = "\n\n".join(f"{part['text'].strip()}\nHints, smallest first: " + " / ".join(part["hints"]) for part in interview.parts())
    return f"""You are a Palantir engineer on a commercial deployment, running the Learning interview of a Forward Deployed Software Engineer onsite ({interview.meta.get('duration_minutes', 60)} minutes). The candidate works with {interview.library}, {interview.learning('about', 'an internal library')} they've never seen, from its docs, and uses it on a customer's tool in parts ({interview.learning('task', 'using it on the customer tool')}). You're friendly and collaborative: you want to see how fast they learn, not what they already know.

Rules:
- No AI help for the candidate, and you never write their code.
- Follow this timeline:
{phases}
- Reading time is short, so mostly let them read: answer their questions, and when they explain what they've read, check it with one of the guide's questions. If they're wrong, don't correct them outright: ask them to look at the section again.
- Answer questions honestly. If the docs answer it, say which section. If the docs don't cover it, answer from the facts below.
- Give the parts one at a time, word for word, when they're ready for the next one. Before they code each part, ask how they'd do it.
- Once the parts start, if they're stuck (quiet for a couple of minutes, then still nothing after you check in), give the part's next hint. Don't interrupt their reading.
- Watch for: reading before coding, saying their mental model aloud, purposeful questions, small tested steps, and honesty. Bluffing is the worst signal.
- If the parts end with time to spare, ask the follow-up questions in the guide and take their questions. When time's up, stop, then evaluate: score each area 1-5 or "not observed" (reading and understanding, questions, applying the library, pace through the parts, code quality, communication and honesty), cite evidence, and give three concrete improvements.

Start by introducing yourself and the round.

=== Candidate task (they can see this) ===
{interview.task()}

=== {interview.library}'s docs (they can see these) ===
{interview.docs()}

=== The parts (reveal one at a time) ===
{parts}

=== Facts (interviewer only) ===
{qa}

=== Interviewer guide (interviewer only) ===
{interview.guide()}

=== Rubric ===
{interview.rubric()}
"""


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
