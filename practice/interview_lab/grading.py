"""Grades a submitted session from evidence: test results, the diff, and what the candidate recorded.

Every score is tied to evidence that is listed next to it. Areas without evidence are
"not observed" rather than guessed. How much the candidate used the coding assistant
is never scored; only how well they directed it and checked its output.
"""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import interviewer, resume
from .catalog import Interview, leadership_bank, test_python
from .session import CHANGE_FILE, PARTS_FILE, Sessions
from .testing import run_pytest, summary
from .workspace import build_starter, diff_against_starter, iter_files, workspace_path

AREAS = [
    ("problem_understanding", "Problem understanding"),
    ("repository_exploration", "Repository exploration"),
    ("ai_instructions", "Quality of AI instructions"),
    ("verification", "Verification of AI output"),
    ("correctness", "Correctness and edge cases"),
    ("testing", "Testing"),
    ("code_quality", "Code quality"),
    ("communication", "Communication and tradeoffs"),
]
# Amazon's final rounds have no AI assistant (candidates are told not to use GenAI unless explicitly permitted),
# so the two AI areas give way to the Leadership Principles and to problem solving and complexity.
AMAZON_AREAS = [
    ("problem_understanding", "Problem understanding"),
    ("leadership", "Leadership Principles"),
    ("problem_solving", "Problem solving and complexity"),
    ("correctness", "Correctness and edge cases"),
    ("testing", "Testing and dry run"),
    ("code_quality", "Code quality"),
    ("communication", "Communication"),
]
BEHAVIORAL_AREAS = [
    ("leadership", "Leadership Principles"),
    ("star", "Story structure (STAR)"),
    ("impact", "Ownership, specifics, and impact"),
    ("followups", "Handling follow-ups"),
    ("self_awareness", "Self-awareness and learning"),
    ("communication", "Communication and pacing"),
]
PROBLEM_AREAS = [
    ("problem_understanding", "Problem understanding"),
    ("problem_solving", "Problem solving and complexity"),
    ("correctness", "Correctness and edge cases"),
    ("testing", "Testing and verification"),
    ("code_quality", "Code quality"),
    ("communication", "Communication"),
]
# The coding round: no Leadership Principles, and the evidence includes how much help you needed (hints, the push to optimize).
CODING_ROUND_AREAS = [
    ("problem_understanding", "Problem understanding"),
    ("problem_solving", "Problem solving and complexity"),
    ("correctness", "Correctness and edge cases"),
    ("testing", "Testing and dry run"),
    ("code_quality", "Code quality"),
    ("communication", "Communication"),
]
RESUME_AREAS = [
    ("walkthrough", "Background walkthrough"),
    ("depth", "Technical depth"),
    ("ownership", "Ownership and impact"),
    ("followups", "Handling follow-ups"),
    ("leadership", "Leadership Principles"),
    ("communication", "Communication and questions"),
]
# The Palantir learning round: how you learned an unfamiliar library and built with it, more than how much you built.
LEARNING_AREAS = [
    ("understanding", "Reading and understanding"),
    ("questions", "Questions"),
    ("applying", "Applying the library"),
    ("pace", "Pace through the parts"),
    ("code_quality", "Code quality"),
    ("communication", "Communication and honesty"),
]
LABELS = {**dict(AREAS), **dict(AMAZON_AREAS), **dict(BEHAVIORAL_AREAS), **dict(PROBLEM_AREAS), **dict(RESUME_AREAS), **dict(LEARNING_AREAS)}
# Saying you aren't sure, or going to check, out loud: what the learning round wants instead of a confident guess.
HONEST = re.compile(r"\b(i'?m not sure|not sure|i don'?t know|let me check|let me look|let me reread|i think|i guess|i might be wrong|if i understand|correct me)\b")
CONVERSATION_FORMATS = ("amazon-behavioral", "resume")  # nothing to run or diff: graded from what was said
# A complexity, written ("O(n)") or as speech recognition spells it ("O of n", "n squared").
COMPLEXITY = re.compile(r"\bo\(|\bo of\b|big[- ]o|\blinear\b|\blog(arithmic)?\b|n log|quadratic|n squared|constant (time|space)")


def resume_deep_dive(interview: Interview) -> bool:
    """True for an Amazon final round that opens with a deep dive on the résumé (the full interview)."""
    return interview.meta.get("format") == "amazon-final" and (interview.meta.get("behavioral") or {}).get("bank") == "resume"


def areas_for(interview: Interview):
    if resume_deep_dive(interview):
        return [AMAZON_AREAS[0], ("depth", "Technical depth"), *AMAZON_AREAS[1:]]
    return {"amazon-final": AMAZON_AREAS, "amazon-coding": CODING_ROUND_AREAS, "amazon-behavioral": BEHAVIORAL_AREAS, "problem": PROBLEM_AREAS,
            "resume": RESUME_AREAS, "palantir-learning": LEARNING_AREAS}.get(interview.meta.get("format"), AREAS)


def _behavioral_scores(interview, state, notes) -> Dict[str, Any]:
    """Scores for a behavioral-only round, each from the stories the candidate told."""
    stories = _stories(interview, state)
    if not stories:
        none = (None, ["No answers were recorded. Press the mic and answer out loud, or type in the chat."])
        return {area: none for area, _ in BEHAVIORAL_AREAS}
    n = len(stories)
    star = [s["star"] for s in stories]
    owned = sum(1 for s in stories if s["i"] >= s["we"])
    numbers = sum(1 for s in stories if s["numbers"])
    handled = sum(s["handled"] for s in stories)
    prompts = sum(s["prompts"] for s in stories)
    reflective = sum(1 for s in stories if s["reflection"])
    lengths = [s["words"] for s in stories]
    paced = sum(1 for w in lengths if 150 <= w <= 700)
    their_questions = [q for q in state.get("questions", []) if q.get("source") != "interviewer"]
    asked = len(Sessions.behavioral_questions(interview, state))
    scores = {
        "star": (_clamp(1 + sum(star) / n), [f"Stories with all four STAR parts: {sum(1 for x in star if x == 4)} of {n}."] + [f"{s['lp'] or 'Story'}: {s['star']}/4 STAR parts." for s in stories]),
        "impact": (_clamp(1 + 2 * owned / n + 2 * numbers / n), [f"Owned with “I” more than “we” in {owned} of {n} stories.", f"Put a number on the result in {numbers} of {n} stories."]),
        "followups": (_clamp(1 + 4 * handled / max(1, prompts)) if handled else 1, [f"Answered {handled} of {prompts} questions and follow-ups.", f"Covered {n} of {asked} principles."]),
        "self_awareness": (_clamp(1 + 4 * reflective / n), [f"Said what you learned or would change in {reflective} of {n} stories."]),
        "communication": (_clamp(1 + 3 * paced / n + (1 if their_questions else 0)), [f"Story lengths: {', '.join(str(w) for w in lengths)} words (about 300–450 is 2–3 minutes).", "Asked the interviewer questions at the end." if their_questions else "Didn't ask the interviewer any questions at the end."]),
    }
    scores["leadership"] = _score_leadership(interview, state)[:2]
    return scores
NOT_SOURCE_PREFIXES = ("tests/", "patch_review/", ".claude/", ".vscode/", "examples/out/")
NOT_SOURCE_FILES = {CHANGE_FILE, PARTS_FILE, "CLAUDE.md", "README.md", ".gitignore", "pytest.ini"}
DISCLAIMER = (
    "Automatic scores are heuristics computed from test results, your diff, and the text you recorded. "
    "Each score lists the evidence it used; 'not observed' means there was no evidence, not a low score. "
    "The amount of AI assistance you used is not scored. For a second opinion, paste the grading prompt into a separate Claude conversation."
)

# Signals in the candidate's messages to the coding assistant.
PROMPT_SIGNALS = [
    ("context", "named files, functions, or tests", r"\w+\.py\b|`[^`]+`|\bdef \w+|\btest_\w+|\bline \d+"),
    ("goal", "stated the expected behaviour", r"\b(should|must|expected?|so that|requirement|acceptance|instead of|return(s|ing)?)\b"),
    ("constraints", "set constraints", r"\b(don'?t|do not|without|only|keep|avoid|minimal|small|focused|no more than|leave)\b"),
    ("plan_first", "asked for an explanation or plan first", r"\b(explain|why|plan|walk me through|before (you|editing|changing|writing|making)|what do you think|hypothes\w*|options?|trade-?offs?|root cause)\b"),
    ("review", "asked to see a diff or approve changes", r"\b(diff|show me|approv\w*|wait for|before applying|let me (see|review)|review)\b"),
    ("tests", "asked for or about tests", r"\b(tests?|pytest|regression|edge cases?|failing)\b"),
]
PUSHBACK = r"\b(that'?s (wrong|not right|incorrect)|not quite|incorrect|doesn'?t (work|handle|look)|didn'?t|instead|revert|undo|why did you|are you sure|that breaks|this breaks|still fails|wrong)\b"
USER_LINE = re.compile(r"^\s*(?:>|❯|(?:\*\*)?(?:user|human|you|me|candidate)(?:\*\*)?\s*:)\s?(.*)$", re.I)
ASSISTANT_LINE = re.compile(r"^\s*(?:⏺|●|(?:\*\*)?(?:assistant|claude|ai)(?:\*\*)?\s*:)", re.I)


def user_turns(transcript: str) -> List[str]:
    """The candidate's own messages in a pasted transcript (Claude Code's /export format, or 'User:' lines)."""
    turns: List[str] = []
    current: Optional[str] = None
    for line in transcript.splitlines():
        match = USER_LINE.match(line)
        if match:
            if current is not None:
                turns.append(current)
            current = match.group(1)
        elif ASSISTANT_LINE.match(line):
            if current is not None:
                turns.append(current)
            current = None
        elif current is not None:
            current += "\n" + line
    if current is not None:
        turns.append(current)
    return [turn.strip() for turn in turns if turn.strip()]


def _quote(text: str, limit: int = 110) -> str:
    text = " ".join(text.split())
    return f"“{text[:limit]}{'…' if len(text) > limit else ''}”"


def _band(ratio: float) -> int:
    return 5 if ratio >= 0.95 else 4 if ratio >= 0.8 else 3 if ratio >= 0.6 else 2 if ratio >= 0.35 else 1


def _clamp(value: float) -> int:
    return int(max(1, min(5, round(value))))


def _starter_test_names(starter_tests: Path) -> set:
    names = set()
    for path in starter_tests.glob("test_*.py"):
        for name in re.findall(r"^def (test_\w+)", path.read_text(encoding="utf-8"), re.M):
            names.add((path.stem, name))
    return names


def _run_all(interview: Interview, home: Path) -> Dict[str, Any]:
    python = test_python(home)
    workspace = workspace_path(interview, home)
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        pristine, candidate, on_starter = root / "starter", root / "candidate", root / "on_starter"
        build_starter(interview, pristine, home)
        for relative, path in iter_files(workspace).items():
            target = candidate / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        # Grade against the supplier's original example data, even if it was edited.
        for relative, path in iter_files(pristine).items():
            if relative.startswith("examples/"):
                (candidate / relative).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, candidate / relative)
        shutil.copytree(pristine / "tests", candidate / "_original_tests")
        shutil.copytree(interview.grading_tests, candidate / "_grading_tests")
        hidden = run_pytest(python, candidate, ["_original_tests", "_grading_tests"])
        has_tests = (workspace / "tests").is_dir()
        own = run_pytest(python, candidate, ["tests"]) if has_tests else None

        build_starter(interview, on_starter, home)
        shutil.rmtree(on_starter / "tests")
        if has_tests:
            shutil.copytree(workspace / "tests", on_starter / "tests", ignore=shutil.ignore_patterns("__pycache__"))
            own_on_starter = run_pytest(python, on_starter, ["tests"])
        else:
            own_on_starter = None
        starter_names = _starter_test_names(pristine / "tests")
        if interview.followup_tests and interview.followup_tests.is_dir():   # the follow-up's example, added when it was revealed
            starter_names |= _starter_test_names(interview.followup_tests)
        for folder in {part["tests_path"].parent for part in interview.parts()}:   # the learning round's examples, one per part
            starter_names |= _starter_test_names(folder)
    return {"hidden": hidden, "own": own, "own_on_starter": own_on_starter, "starter_names": starter_names}


def _test_evidence(interview: Interview, runs: Dict[str, Any]) -> Dict[str, Any]:
    cases = interview.cases()
    by_area: Dict[str, Dict[str, int]] = {}
    missed: List[Dict[str, Any]] = []
    seen_missed = set()
    for case in runs["hidden"]["cases"]:
        info = cases.get(case["base"], {})
        area = info.get("area", "core")
        bucket = by_area.setdefault(area, {"passed": 0, "total": 0})
        bucket["total"] += 1
        if case["outcome"] == "passed":
            bucket["passed"] += 1
        elif case["base"] not in seen_missed:
            seen_missed.add(case["base"])
            missed.append({"test": case["base"], "area": area, "description": info.get("description", case["base"]), "topic": info.get("topic"), "message": case["message"]})

    added, detecting = [], []
    own, on_starter = runs["own"], runs["own_on_starter"]
    if own:
        starter_outcomes = {(c["module"], c["name"]): c["outcome"] for c in (on_starter or {}).get("cases", []) if not c["collection_error"]}
        broken_on_starter = {c["module"] for c in (on_starter or {}).get("cases", []) if c["collection_error"]}
        for case in own["cases"]:
            if case["collection_error"] or (case["module"], case["base"]) in runs["starter_names"]:
                continue
            added.append(case)
            fails_on_starter = case["module"] in broken_on_starter or starter_outcomes.get((case["module"], case["name"])) in ("failed", "error")
            if case["outcome"] == "passed" and fails_on_starter:
                detecting.append(case)
    return {"by_area": by_area, "missed": missed, "added": added, "detecting": detecting}


def _diff_evidence(interview: Interview, diff: Dict[str, Any]) -> Dict[str, Any]:
    source, weakened, data_edits = [], [], []
    starter_tests = {f"tests/{p.name}" for p in (interview.starter / "tests").glob("test_*.py")}
    for item in diff["files"]:
        path = item["path"]
        if path in starter_tests and item["status"] != "added":
            removed_asserts = [line for line in item["removed_lines"] if line.strip().startswith("assert")]
            removed_tests = [line for line in item["removed_lines"] if line.startswith("def test_")]
            kept = {line.strip() for line in item["added_lines"]}
            lost = [line.strip() for line in removed_asserts + removed_tests if line.strip() not in kept]
            if item["status"] == "deleted" or lost:
                weakened.append({"path": path, "lines": lost[:5], "deleted": item["status"] == "deleted"})
        elif path.startswith("examples/") and not path.startswith("examples/out/") and item["status"] != "added":
            data_edits.append(path)
        elif not path.startswith(NOT_SOURCE_PREFIXES) and path not in NOT_SOURCE_FILES:
            source.append(item)
    return {"source": source, "weakened": weakened, "data_edits": data_edits}


def _patch_review(interview: Interview, text: str) -> Dict[str, Any]:
    key = interview.patch_review()
    lowered = text.lower()
    found = [group["label"] for group in key.get("issue_groups", []) if any(k in lowered for k in group["keywords"])]
    return {"found": found, "needed": key.get("main_issue_groups_needed", 2), "expected": key.get("summary", ""), "written": bool(text.strip())}


def _score_problem_understanding(interview, state, notes):
    questions = [q for q in state.get("questions", []) if q.get("source") != "interviewer"]
    stated = " ".join([notes["assumptions"], notes["plan"]])
    if not questions and not stated.strip():
        return None, ["No clarification questions, assumptions, or plan were recorded."], {"covered": [], "missed": [t["topic"] for t in interview.clarifications() if t.get("important")]}
    coverage = interviewer.topics_covered(interview, questions, stated)
    total = len(coverage["covered"]) + len(coverage["missed"]) or 1
    ratio = len(coverage["covered"]) / total
    score = 1 + round(3 * ratio) + (1 if len(notes["assumptions"].strip()) >= 15 else 0)
    evidence = [f"Asked {len(questions)} clarification question(s); covered {len(coverage['covered'])} of {total} important topics."]
    if coverage["covered"]:
        evidence.append("Covered: " + "; ".join(coverage["covered"]) + ".")
    if coverage["missed"]:
        evidence.append("Not asked about or stated as an assumption: " + "; ".join(coverage["missed"]) + ".")
    evidence.append("Assumptions were recorded." if notes["assumptions"].strip() else "No assumptions were recorded.")
    return _clamp(score), evidence, coverage


def _score_exploration(interview, notes):
    text = "\n".join([notes["plan"], notes["transcript"], notes["explanation"], notes["spoken"]])
    if not notes["plan"].strip() and not notes["transcript"].strip() and not notes["spoken"].strip():
        return None, ["No plan, transcript, or spoken walkthrough was recorded, so exploration could not be observed."]
    package = interview.meta.get("package", "")
    mentioned = []
    for source in interview.meta.get("source_files", []):
        stem = Path(source).stem
        patterns = [re.escape(Path(source).name), re.escape(source), rf"\b{re.escape(package)}\.{re.escape(stem)}\b", rf"`{re.escape(stem)}`"]
        if any(re.search(p, text) for p in patterns):
            mentioned.append(source)
    plan_words = len(notes["plan"].split())
    score = 1 + min(3, len(mentioned)) + (1 if plan_words >= 40 else 0)
    evidence = [f"Your plan, transcript, and explanation reference {len(mentioned)} of {len(interview.meta.get('source_files', []))} source files" + (f": {', '.join(mentioned)}." if mentioned else ".")]
    evidence.append(f"The written plan has {plan_words} words." if plan_words else "No written plan.")
    return _clamp(score), evidence


def _score_ai_instructions(notes):
    transcript = notes["transcript"]
    if not transcript.strip():
        return None, ["No coding-assistant transcript was supplied (paste it into Transcript; in Claude Code, /export copies the conversation)."], []
    turns = user_turns(transcript)
    evidence = []
    if not turns:
        turns = [transcript]
        evidence.append("Could not tell your messages apart from the assistant's, so the whole transcript was scanned (less reliable).")
    present, missing = [], []
    for key, label, pattern in PROMPT_SIGNALS:
        example = next((turn for turn in turns if re.search(pattern, turn, re.I)), None)
        if example:
            present.append(key)
            evidence.append(f"You {label}, e.g. {_quote(example)}")
        else:
            missing.append(label)
    vague = [turn for turn in turns if len(turn.split()) <= 4]
    if vague:
        evidence.append(f"{len(vague)} very short prompt(s), e.g. {_quote(vague[0])}")
    if missing:
        evidence.append("Not seen in your prompts: " + "; ".join(missing) + ".")
    count = len(present)
    score = 1 if count <= 1 else 2 if count == 2 else 3 if count == 3 else 4 if count <= 5 else 5
    return score, [f"Read {len(turns)} message(s) you sent to the assistant."] + evidence, missing


def _score_verification(state, notes, patch, revealed_at):
    runs = state.get("test_runs", [])
    turns = user_turns(notes["transcript"]) if notes["transcript"].strip() else []
    if not runs and not patch["written"] and not notes["transcript"].strip():
        return None, ["No test runs, patch review, or transcript were recorded."]
    points, evidence = 0, []
    if runs:
        points += 1
        after_change = [r for r in runs if revealed_at is not None and r["at"] >= revealed_at]
        if len(runs) >= 3 or after_change:
            points += 1
        evidence.append(f"Ran the visible tests {len(runs)} time(s) from the dashboard" + (f", {len(after_change)} after the requirement change." if revealed_at is not None else "."))
    else:
        evidence.append("Never ran the tests from the dashboard (runs in your own terminal are not recorded).")
    if patch["written"]:
        if len(patch["found"]) >= patch["needed"]:
            points += 2
            evidence.append("Patch review identified the main problem: " + "; ".join(patch["found"]) + ".")
        elif patch["found"]:
            points += 1
            evidence.append("Patch review found part of the problem: " + "; ".join(patch["found"]) + ".")
        else:
            evidence.append("Patch review did not identify the patch's main problem.")
    else:
        evidence.append("No patch review was written.")
    pushback = next((turn for turn in turns if re.search(PUSHBACK, turn, re.I)), None)
    test_asks = next((turn for turn in turns if re.search(r"\b(run (the )?tests?|pytest)\b", turn, re.I)), None)
    if pushback:
        points += 1
        evidence.append(f"Pushed back on the assistant: {_quote(pushback)}")
    elif test_asks:
        evidence.append(f"Asked the assistant to run tests: {_quote(test_asks)}")
    return _clamp(1 + min(4, points)), evidence


def _score_correctness(runs, tests):
    hidden = runs["hidden"]
    if not hidden["total"]:
        return 1, ["The grading tests could not run: " + hidden["output"][:300]]
    ratio = hidden["passed"] / hidden["total"]
    evidence = [f"Grading tests: {hidden['passed']} of {hidden['total']} passed."]
    names = {"core": "Core requirements", "edge": "Edge cases", "change": "Requirement change"}
    for area in ("core", "edge", "change"):
        if area in tests["by_area"]:
            bucket = tests["by_area"][area]
            evidence.append(f"{names[area]}: {bucket['passed']}/{bucket['total']}.")
    collection = [c for c in hidden["cases"] if c["collection_error"]]
    if collection:
        evidence.append(f"{len(collection)} test module(s) failed to import: {collection[0]['message']}")
    return _band(ratio), evidence


def _score_testing(runs, tests, diff):
    own = runs["own"]
    evidence, points = [], 0
    added, detecting = tests["added"], tests["detecting"]
    if added:
        points += 1
        evidence.append(f"Added {len(added)} test(s): " + ", ".join(sorted({c['base'] for c in added}))[:300] + ".")
    else:
        evidence.append("No new tests were added.")
    if detecting:
        points += 1 + (1 if len({c['base'] for c in detecting}) >= 3 else 0)
        evidence.append(f"{len(detecting)} of your new test(s) fail on the original starter and pass on your code, so they catch real defects.")
    elif added:
        evidence.append("None of your new tests fail on the original starter, so they do not catch the planted defects.")
    if own and own["total"]:
        if own["ok"]:
            points += 1
            evidence.append(f"Your test suite passes: {own['passed']} passed.")
        else:
            evidence.append(f"Your test suite does not pass: {own['failed']} failed, {own['errors']} errors.")
    for item in diff["weakened"]:
        points -= 1
        what = "was deleted" if item["deleted"] else "lost assertions: " + "; ".join(item["lines"])
        evidence.append(f"Visible test file {item['path']} {what}.")
    return _clamp(1 + points), evidence


def _score_code_quality(diff):
    source = diff["source"]
    if not source:
        return None, ["No source files were changed, so code quality could not be assessed."], []
    added = [(item["path"], line) for item in source for line in item["added_lines"]]
    changed = sum(len(item["added_lines"]) + len(item["removed_lines"]) for item in source)
    smells = []
    checks = [
        ("leftover print() calls", lambda path, line: re.match(r"\s*print\(", line) and not path.startswith(("examples/", "scripts/"))),
        ("leftover debugger calls", lambda path, line: re.search(r"\b(breakpoint\(\)|pdb\.set_trace|import pdb)", line)),
        ("errors swallowed with a bare except or `except Exception: pass`", lambda path, line: re.match(r"\s*except\s*:", line) or re.search(r"except Exception:\s*pass", line)),
        ("new TODO/FIXME comments", lambda path, line: re.search(r"#\s*(TODO|FIXME|XXX)", line)),
        ("commented-out code", lambda path, line: re.match(r"\s*#\s*(def |return |if |for |while |import |self\.)", line)),
    ]
    for label, check in checks:
        hits = [(p, l) for p, l in added if check(p, l)]
        if hits:
            smells.append(f"{label} ({hits[0][0]}: {_quote(hits[0][1], 60)})")
    if changed > 250:
        smells.append(f"a large change ({changed} lines) for focused fixes")
    if diff["data_edits"]:
        smells.append("edited example data (" + ", ".join(diff["data_edits"]) + ") instead of handling it in code")
    evidence = [f"Changed {changed} source line(s) across {len(source)} file(s): " + ", ".join(f"{i['path']} ({i['status']})" for i in source) + "."]
    evidence += [f"Found {smell}." for smell in smells] or ["No leftover debugging, swallowed errors, or commented-out code in the diff."]
    score = 5 - len(smells) if changed <= 150 else 4 - len(smells)
    return _clamp(score), evidence, smells


def _score_communication(interview, notes):
    text = "\n".join(part for part in (notes["explanation"], notes["spoken_late"]) if part.strip())
    if not text.strip():
        return None, ["No final explanation was written or spoken."], []
    checks = [
        ("enough detail (80+ words)", len(text.split()) >= 80),
        ("tradeoffs or alternatives", re.search(r"\b(trade-?offs?|because|instead|alternatives?|downside|risk|cost|chose|choice)\b", text, re.I)),
        ("how you verified it", re.search(r"\b(tests?|verified|verify|checked|pytest|reproduc\w*)\b", text, re.I)),
        ("the requirement change", any(k.lower() in text.lower() for k in interview.meta.get("change_keywords", ["requirement change"]))),
        ("assumptions, limits, or next steps", re.search(r"\b(assum\w*|limitation\w*|production|future|next steps?|would also|didn'?t|not handled|left)\b", text, re.I)),
    ]
    present = [label for label, ok in checks if ok]
    missing = [label for label, ok in checks if not ok]
    evidence = [f"Final explanation: {len(notes['explanation'].split())} written words" + (f" and {len(notes['spoken_late'].split())} spoken words in the last 20 minutes." if notes["spoken_late"].strip() else ".")]
    if present:
        evidence.append("It covers " + "; ".join(present) + ".")
    if missing:
        evidence.append("It does not cover " + "; ".join(missing) + ".")
    return max(1, len(present)), evidence, missing


STAR = [
    ("situation", "set the scene", r"\b(when i was|while i was|as an?|at (my|a|the|our)|during (my|a|the|our)|in my|last (year|summer|semester|spring|fall|winter)|my (first|second|freshman|sophomore|junior|senior) year|internship|project|class|course|club|hackathon|startup|job|team|lab|center|semester)\b"),
    ("task", "said what you had to do", r"\b(my (role|job|task|responsibility|goal|part)|i was (responsible|asked|assigned|supposed|in charge|trying)|we needed to|i needed to|the goal|deadline|had to|i noticed|the problem was|the challenge was|we were asked|needed to)\b"),
    ("action", "said what you did yourself", None),
    ("result", "said how it turned out", r"\b(as a result|result(ed|s)?|outcome|in the end|eventually|ended up|shipped|launched|delivered|reduced|increased|improved|saved|cut|grew|won|finished|on time|so we|dropped|fell|rose|went (up|down))\b"),
    ("numbers", "put a number on the result", r"\d+(\.\d+)?\s*(%|percent|x\b|times|hours?|days?|weeks?|months?|users|people|customers|members|teams|ms|seconds|minutes|bugs|points|dollars)|\$\d|\bfrom \d+(\.\d+)? to \d+|\b(doubled|tripled|halved|by half)\b|\b\d+ (out of|of) \d+"),
    ("reflection", "said what you learned or would change", r"\b(learned|learnt|would do differently|next time|in hindsight|looking back|lesson|i realized|i'd change|now i)\b"),
]
ACTION = r"\bi (\w+ed|reached out|set up|ran|made|built|wrote|rewrote|led|took|set|found|told|met|got|gave|brought|chose|drove|began|kept|sent|spent|taught|thought|broke|did|went|saw|read|cut|split|put|shared|won|stood|sat|spoke|chose|rebuilt)\b"


def _shingles(text: str) -> set:
    words = re.findall(r"[a-z0-9']+", text.lower())
    return {" ".join(words[i:i + 3]) for i in range(len(words) - 2)}


def _overlap(a: str, b: str) -> float:
    """How much of a repeats b, by three-word runs (0 to 1)."""
    first, second = _shingles(a), _shingles(b)
    return len(first & second) / len(first) if first else 0.0


def _story(answer: Dict[str, Any], bank: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Scores one Leadership Principles story: STAR, ownership, numbers, reflection, the principle itself, and detail."""
    text = " ".join(part["text"] for part in answer["parts"])
    lowered = text.lower()
    words = len(text.split())
    hits, missing = [], []
    for key, label, pattern in STAR:
        ok = len(re.findall(ACTION, lowered)) >= 2 if key == "action" else re.search(pattern, lowered) is not None
        (hits if ok else missing).append(label)
    i_count, we_count = len(re.findall(r"\bi\b", lowered)), len(re.findall(r"\bwe\b", lowered))
    (hits if i_count >= we_count else missing).append("owned it" if i_count >= we_count else "used “I” more than “we”")
    signals = bank.get(answer.get("lp") or "", {}).get("signals", [])
    shown = sorted({signal for signal in signals if signal in lowered})
    if signals:
        (hits if len(shown) >= 2 else missing).append(f"showed {answer['lp']}" if len(shown) >= 2 else f"made {answer['lp']} visible (for example: {', '.join(signals[:4])})")
    if 150 <= words <= 700:
        hits.append("right length")
    else:
        missing.append("enough detail (150+ words across the story and follow-ups)" if words < 150 else "a tighter story (over 700 words; aim for about 2–3 minutes)")
    prompts = len(answer.get("prompts", [])) or 1
    # A follow-up counts as handled only when the answer adds something new, not when it repeats the story.
    parts = [part["text"] for part in answer["parts"]]
    fresh = [parts[0]] + [part for i, part in enumerate(parts[1:], 1) if _overlap(part, " ".join(parts[:i])) < 0.6] if parts else []
    handled = min(prompts, len(fresh))
    if len(fresh) < len(parts):
        missing.append("new detail in each follow-up answer (some repeated what you'd already said)")
    total = len(STAR) + 2 + (1 if signals else 0)
    score = _clamp(1 + 4 * len(hits) / total - (1 if handled < prompts else 0))
    if signals and len(shown) < 2:
        score = min(score, 3)  # a good story that doesn't show the principle asked about
    star = sum(1 for key, label, _ in STAR[:4] if label in hits)
    return {"lp": answer.get("lp"), "question": answer["question"], "score": score, "words": words, "i": i_count, "we": we_count,
            "handled": handled, "prompts": prompts, "missing": missing, "hits": hits, "star": star, "text": text,
            "numbers": "put a number on the result" in hits, "reflection": "said what you learned or would change" in hits}


def _stories(interview, state) -> List[Dict[str, Any]]:
    bank = {entry["lp"]: entry for entry in leadership_bank()}
    for item in Sessions.behavioral_questions(interview, state):
        bank.setdefault(item.get("lp") or "", {"signals": item.get("signals", [])})
    # Only the principles questions: a résumé deep dive in the same part of the interview is scored as technical depth.
    stories = [_story(a, bank) for a in state.get("behavioral", {}).get("answers", []) if a.get("parts") and a.get("lp")]
    # Interviewers want a different story for each principle.
    for i, story in enumerate(stories):
        reused = [earlier for earlier in stories[:i] if _overlap(story["text"], earlier["text"]) >= 0.5]
        if reused:
            story["score"] = min(story["score"], 2)
            story["reused"] = reused[0]["lp"]
            story["missing"].append(f"a different story (this one reuses your {reused[0]['lp']} story)")
    return stories


def _score_leadership(interview, state):
    stories = _stories(interview, state)
    if not stories:
        return None, ["No Leadership Principles answers were recorded. Answer out loud with the mic, or type in the chat, while the interviewer asks its questions."], []
    evidence, missing_all = [], set()
    for story in stories:
        missing_all.update(story["missing"])
        lp = f" ({story['lp']})" if story.get("lp") else ""
        evidence.append(f"{_quote(story['question'], 80)}{lp}: {story['score']}/5 · {story['words']} words · “I” {story['i']} vs “we” {story['we']} · answered {story['handled']} of {story['prompts']} prompts. "
                        + (f"Missing: {'; '.join(story['missing'])}." if story["missing"] else "Hit every signal.") + f" You said: {_quote(story['text'], 120)}")
    asked = len([item for item in Sessions.behavioral_questions(interview, state) if item.get("lp")])
    if len(stories) < asked:
        evidence.append(f"Answered {len(stories)} of {asked} Leadership Principles questions.")
    average = sum(story["score"] for story in stories) / len(stories)
    return _clamp(average - (0.5 if len(stories) < asked else 0)), evidence, sorted(missing_all)


def lp_breakdown(interview, state) -> List[Dict[str, Any]]:
    return [{"lp": story["lp"], "question": story["question"], "score": story["score"], "missing": story["missing"]} for story in _stories(interview, state)]


# Résumé deep dive: what the candidate said, turn by turn, scored on what a senior engineer listens for.
DECISION = r"\b(because|so that|instead of|rather than|trade-?offs?|chose|choose|decided|decision|alternatives?|compared|versus|vs\.?|pros and cons|the downside|the reason)\b"
BUILD = (r"\b(api|apis|endpoint|database|schema|tables?|queries|query|index(es)?|cach(e|ing)|queue|server|client|frontend|front end|backend|back end|service|"
         r"microservices?|pipeline|model|latency|throughput|scal(e|ed|ing|able)|concurren\w+|threads?|async\w*|deploy\w*|docker|kubernetes|aws|cloud|ci|tests?|"
         r"websockets?|rest|graphql|react|state|algorithm|data structure|hash ?map|load|memory|cpu|batch\w*|polling|webhooks?|auth\w*)\b")
DEBUG = r"\b(bug|bugs|debug\w*|root cause|logs?|logging|profil\w*|traced?|reproduc\w+|broke|broken|crash\w*|race condition|memory leak|the issue was|turned out)\b"
FAILURE = r"\b(crash\w*|fail(s|ed|ure|over)?|retr(y|ies|ied)|idempoten\w*|duplicates?|out of order|timeouts?|fallback|backpressure|rate limit\w*|lost|durab\w*|persist\w*|consisten\w*|race|locks?|bottleneck\w*|10x|100x|ten times|hundred times|at scale|shard\w*|replica\w*)\b"
STRUCTURE = r"\b(currently|right now|at the moment|i'?m a|i am a|before that|most recently|previously|last summer|started|looking for|interested in|next|excited about|want to)\b"
WRAP_PROMPT = r"questions?\s+(do you have|for me)|anything you'?d like to ask|what would you like to know"


RESUME_IMPROVEMENTS = {
    "walkthrough": "Practice a two-minute walkthrough: where you are now, the two experiences you most want to discuss and why, and what you're looking for next.",
    "depth": "For each project on your résumé, be ready to explain how it works end to end, one decision with the alternative you rejected, and the hardest bug you hit.",
    "ownership": "Say “I” for your own work, and end answers about results with a number: users, latency, time saved, or percent.",
    "followups": "Answer each follow-up directly in the first sentence, then add one new detail. Avoid one-line answers and repeating an earlier answer.",
    "leadership": ("Prepare STAR stories from your résumé for the principles Amazon asks interns about most (Customer Obsession, Ownership, Learn and Be Curious, "
                   "Have Backbone; Disagree and Commit, Deliver Results): the situation in a sentence, what you did, the result with a number, what you learned."),
    "communication": "Keep answers to 30–90 seconds and let the interviewer steer, and prepare two thoughtful questions about the team for the end.",
}


def resume_turns(interview: Interview, state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The candidate's turns in order, each with the interviewer line it answered, what kind of question it was, and, in
    the Leadership Principles section, which principle."""
    events: List[Tuple[float, float, str, str, Optional[str]]] = []  # (time, order, who, text, section it opens)
    for q in state.get("questions", []):
        n = q.get("n", 0)
        if q.get("source") == "interviewer":
            events.append((q["at"], n, "interviewer", q["answer"], q.get("section")))
        else:
            events.append((q["at"], n - 0.5, "candidate", q.get("question", ""), None))  # said before the reply was recorded
            events.append((q["at"], n, "interviewer", q["answer"], q.get("section")))
    events += [(part["at"], part.get("n", 0), "candidate", part["text"], None) for answer in state.get("behavioral", {}).get("answers", []) for part in answer.get("parts", [])]
    events += [(s["at"], s.get("n", 0), "candidate", s["text"], None) for s in state.get("spoken", [])]
    asked = [item for item in Sessions.behavioral_questions(interview, state) if item.get("lp")]
    turns: List[Dict[str, Any]] = []
    prompt, merging, in_section, principle = "", False, False, None
    for at, _, who, text, opens in sorted(events, key=lambda event: event[:2]):
        if who == "interviewer":
            prompt, merging = text, False
            if opens:
                in_section, principle = True, 0
            elif in_section and re.search(WRAP_PROMPT, text.lower()):
                in_section = False
            elif in_section:
                closest = resume.closest_principle(text, asked)
                if closest is not None and closest > (principle or 0):
                    principle = closest  # moved on to the next question
        elif text.strip():
            if merging:
                turns[-1]["text"] += " " + text.strip()
            else:
                turns.append({"at": at, "prompt": prompt, "text": text.strip(), "section": in_section, "principle": principle if in_section else None})
                merging = True
    for i, turn in enumerate(turns):
        prompt = turn["prompt"].lower()
        turn["kind"] = ("walkthrough" if i == 0 else "wrap" if re.search(WRAP_PROMPT, prompt) or (turn["at"] >= 27 * 60 and interviewer.is_question(turn["text"]))
                        else "leadership" if turn["section"] else "depth")
        turn["words"] = len(turn["text"].split())
    return turns


def resume_principles(interview: Interview, state: Dict[str, Any], turns: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """One story per principle asked, scored like the Amazon behavioral round."""
    asked = [item for item in Sessions.behavioral_questions(interview, state) if item.get("lp")]
    turns = resume_turns(interview, state) if turns is None else turns
    bank = {entry["lp"]: entry for entry in leadership_bank()}
    stories = []
    for i, item in enumerate(asked):
        mine = [t for t in turns if t["kind"] == "leadership" and t["principle"] == i]
        if mine:
            answer = {"question": item["question"].replace(resume.LP_INTRO, ""), "lp": item["lp"],
                      "prompts": [t["prompt"] for t in mine], "parts": [{"text": t["text"]} for t in mine]}
            stories.append(_story(answer, bank))
    return stories


def _score_depth(deep: List[Dict[str, Any]], named: List[str], covered: List[str] = ()):
    """Technical depth from the deep-dive answers (each with its "text"): decisions, how it works, bugs, failure and scale,
    and which of the résumé's items (`named`; `covered` were already mentioned elsewhere) the candidate explained."""
    if not deep:
        return None, ["No deep-dive answers were recorded."]
    mentions = lambda text: sorted({term for term in named if re.search(rf"(?<![\w]){re.escape(term.lower())}(?![\w])", text.lower())})
    count = lambda pattern, text: len(re.findall(pattern, text.lower()))
    decided = [t for t in deep if count(DECISION, t["text"])]
    built = sorted({match.group(0) for t in deep for match in re.finditer(BUILD, t["text"].lower())})
    debugged = [t for t in deep if count(DEBUG, t["text"])]
    reasoned = [t for t in deep if count(FAILURE, t["text"])]
    explained = sorted({term for t in deep for term in mentions(t["text"])})
    unexplained = [term for term in named if term not in explained and term not in covered][:8]
    best = max(deep, key=lambda t: count(DECISION, t["text"]) + count(BUILD, t["text"]) + count(DEBUG, t["text"]))
    return (_clamp(1 + 1.5 * min(1, len(decided) / max(1, len(deep) / 2)) + min(1, len(built) / 8) + (0.375 if debugged else 0) + (0.375 if reasoned else 0) + min(0.75, 0.25 * len(explained))), [
        f"Explained why (a decision, a tradeoff, an alternative) in {len(decided)} of {len(deep)} deep-dive answers.",
        f"Talked about how things work: {', '.join(built[:10]) if built else 'no architecture or implementation details'}.",
        f"Told {len(debugged)} debugging or obstacle stor{'y' if len(debugged) == 1 else 'ies'}." if debugged else "Never described a bug or obstacle and how you tracked it down.",
        f"Reasoned about failure or scale (crashes, retries, duplicates, 10x load) in {len(reasoned)} answer(s)." if reasoned else "Never reasoned through a failure or scale scenario (a crash halfway, duplicates, 10x load).",
        f"Résumé items you explained: {', '.join(explained[:10]) or 'none by name'}." + (f" Not discussed: {', '.join(unexplained)}." if unexplained else ""),
        f"Strongest answer: {_quote(best['text'], 140)}"])


def _score_resume_deep_dive(interview: Interview, state: Dict[str, Any], resume_text: str):
    """The full Amazon interview's résumé deep dive: each answer to it and its follow-ups, scored like the résumé round."""
    deep_ids = {item["id"] for item in Sessions.behavioral_questions(interview, state) if item.get("kind") == "depth"}
    parts = [{"text": part["text"]} for answer in state.get("behavioral", {}).get("answers", []) if answer.get("id") in deep_ids for part in answer.get("parts", [])]
    return _score_depth(parts, resume.terms(resume_text))


def _resume_scores(interview: Interview, state: Dict[str, Any], resume_text: str) -> Dict[str, Any]:
    turns = resume_turns(interview, state)
    if not turns:
        none = (None, ["Nothing you said was recorded. Turn on the mic and answer out loud, or type in the chat."])
        return {area: none for area, _ in RESUME_AREAS}
    named = resume.terms(resume_text)
    mentions = lambda text: sorted({term for term in named if re.search(rf"(?<![\w]){re.escape(term.lower())}(?![\w])", text.lower())})
    count = lambda pattern, text: len(re.findall(pattern, text.lower()))
    scores: Dict[str, Any] = {}

    first = turns[0]
    covered, structure = mentions(first["text"]), count(STRUCTURE, first["text"])
    length_ok = 100 <= first["words"] <= 450
    scores["walkthrough"] = (_clamp(1 + (1.5 if length_ok else 0.75 if 50 <= first["words"] <= 600 else 0) + min(1.5, 0.3 * len(covered)) + (1 if structure >= 2 else 0.5 if structure else 0)), [
        f"Your walkthrough was {first['words']} words ({'about right: one to three minutes' if length_ok else 'too short to cover your background' if first['words'] < 100 else 'long; aim for two to three minutes'}).",
        f"It named {len(covered)} thing(s) from your résumé" + (f": {', '.join(covered[:8])}." if covered else "."),
        "It was organized (where you are now, what you did before, what you want next)." if structure >= 2 else "Organize it: where you are now, the experiences that matter, what you're looking for next.",
        f"You said: {_quote(first['text'], 140)}"])

    deep = [t for t in turns if t["kind"] == "depth"]
    scores["depth"] = _score_depth(deep, named, covered)

    owned = [t for t in turns if t["kind"] != "wrap"]
    i_count = sum(count(r"\bi\b", t["text"]) for t in owned)
    we_count = sum(count(r"\bwe\b", t["text"]) for t in owned)
    own_share = sum(1 for t in owned if count(r"\bi\b", t["text"]) >= count(r"\bwe\b", t["text"])) / len(owned)
    measured = [t for t in deep if re.search(STAR[4][2], t["text"].lower())]
    scores["ownership"] = (_clamp(1 + 2 * own_share + (2 * min(1, len(measured) / max(1, min(3, len(deep)))) if deep else 0)), [
        f"“I” {i_count} times and “we” {we_count} times; you owned the work in {round(own_share * 100)}% of your answers.",
        f"Put a number on a result in {len(measured)} answer(s)" + (f", for example: {_quote(measured[0]['text'], 110)}" if measured else ". Interviewers listen for users, latency, time saved, or percent."),
    ])

    asked = [t for t in turns if t["kind"] != "wrap" and "?" in t["prompt"]] or [t for t in turns if t["kind"] != "wrap"]
    fresh = [t for i, t in enumerate(asked) if t["words"] >= 15 and _overlap(t["text"], " ".join(x["text"] for x in asked[:i])) < 0.6]
    short = [t for t in asked if t["words"] < 15]
    scores["followups"] = (_clamp(1 + 4 * len(fresh) / max(1, len(asked))), [
        f"Gave a substantive, new answer to {len(fresh)} of {len(asked)} questions.",
        (f"{len(short)} answer(s) were very short, such as: {_quote(short[0]['text'], 80)} (asked: {_quote(short[0]['prompt'], 80)})" if short else "No one-line answers."),
    ])

    stories = resume_principles(interview, state, turns)
    planned = len([item for item in Sessions.behavioral_questions(interview, state) if item.get("lp")])
    if stories:
        evidence = [f"{story['lp']}: {story['score']}/5 · {story['words']} words · “I” {story['i']} vs “we” {story['we']}. "
                    + (f"Missing: {'; '.join(story['missing'])}." if story["missing"] else "Hit every signal.") + f" You said: {_quote(story['text'], 120)}" for story in stories]
        if len(stories) < planned:
            evidence.append(f"Answered {len(stories)} of {planned} Leadership Principles questions.")
        scores["leadership"] = (_clamp(sum(story["score"] for story in stories) / len(stories) - (0.5 if len(stories) < planned else 0)), evidence)
    else:
        scores["leadership"] = (None, ["The interview didn't reach the Leadership Principles section (minutes 19–27)."])

    talk = [t for t in turns if t["kind"] != "wrap"]
    paced = [t for t in talk if 25 <= t["words"] <= 350]
    theirs = [t for t in turns if t["kind"] == "wrap" or t["at"] >= 25 * 60 and "?" in t["text"]]
    longest = max(talk, key=lambda t: t["words"]) if talk else None
    scores["communication"] = (_clamp(1 + 3 * len(paced) / max(1, len(talk)) + (1 if theirs else 0)), [
        f"{len(paced)} of {len(talk)} answers were a good length (about 15 seconds to 2½ minutes).",
        f"Longest answer: {longest['words']} words." if longest else "",
        f"You asked {len(theirs)} question(s) at the end, such as: {_quote(theirs[0]['text'], 100)}" if theirs else "You didn't ask the interviewer any questions at the end.",
    ])
    return {area: (score, [line for line in evidence if line]) for area, (score, evidence) in scores.items()}


def _score_problem_solving(interview, notes, runs):
    text = "\n".join([notes["plan"], notes["explanation"], notes["spoken"]]).lower()
    perf = [c for c in runs["hidden"]["cases"] if interview.cases().get(c["base"], {}).get("area") == "performance"]
    if not text.strip() and not perf:
        return None, ["No approach or complexity was written or said."], []
    checks = [
        ("stated the time complexity", COMPLEXITY.search(text)),
        ("named a fitting data structure or algorithm", any(k in text for k in interview.meta.get("approach_keywords", []))),
        ("compared it with a simpler or brute-force approach", re.search(r"\b(brute[- ]force|naive|simpler|optimi[sz]|better|faster|alternative|instead of|trade-?offs?)\b", text)),
        ("discussed space or memory", re.search(r"\bspace\b|\bmemory\b", text)),
    ]
    present = [label for label, ok in checks if ok]
    missing = [label for label, ok in checks if not ok]
    evidence = []
    if present:
        evidence.append("You " + "; ".join(present) + ".")
    if missing:
        evidence.append("Not seen in what you wrote or said: " + "; ".join(missing) + ".")
    points = len(present)
    if perf:
        fast = all(c["outcome"] == "passed" for c in perf)
        points += 1 if fast else 0
        evidence.append("Your solution passes the large-input performance tests." if fast else "Your solution fails the large-input performance tests: " + perf[0]["message"])
    return _clamp(1 + points * 4 / (len(checks) + (1 if perf else 0))), evidence, missing


def _score_amazon_communication(interview, state, notes):
    phases = interview.phases()
    # The coding round's approach comes before its coding part, out loud, so what you said then counts too.
    kinds = ("approach", "coding") if interview.meta.get("format") == "amazon-coding" else ("coding",)
    coding = [p for p in phases if p.get("kind") in kinds]
    start, end = (coding[0]["start"] * 60, coding[-1]["end"] * 60) if coding else (0, 10 ** 9)
    narrated = " ".join(s["text"] for s in state.get("spoken", []) if start <= s["at"] < end)
    last = phases[-1]["start"] * 60 if phases else 0
    their_questions = [q for q in state.get("questions", []) if q.get("source") != "interviewer" and q["at"] >= last]
    if not narrated.strip() and not notes["explanation"].strip() and not their_questions:
        return None, ["Nothing was said aloud while coding, no walkthrough was written, and you asked no questions at the end."], []
    checks = [
        ("thought out loud while coding (100+ words)", len(narrated.split()) >= 100),
        ("explained the approach before coding", re.search(r"\b(my approach|i('ll| will| am going to| want to)|the idea is|plan is|first i|i think we can)\b", (narrated + " " + notes["plan"]).lower())),
        ("walked through an example or dry run", re.search(r"\b(dry run|walk(ing)? through|trace|let's try|for example|example)\b", (narrated + " " + notes["explanation"]).lower())),
        ("asked the interviewer questions at the end", bool(their_questions)) if interview.meta.get("format") != "problem" else
        ("stated the complexity out loud", COMPLEXITY.search(narrated.lower()) is not None),
    ]
    present = [label for label, ok in checks if ok]
    missing = [label for label, ok in checks if not ok]
    evidence = [f"You said {len(narrated.split())} words while coding and wrote {len(notes['explanation'].split())} in your walkthrough."]
    if present:
        evidence.append("You " + "; ".join(present) + ".")
    if missing:
        evidence.append("Missing: " + "; ".join(missing) + ".")
    return _clamp(1 + len(present)), evidence, missing


LEARNING_PACE = (1, 2, 3, 4, 5)   # the pace score by parts finished in the learning round's 35 minutes of building


def _learning_scores(interview: Interview, state: Dict[str, Any], notes: Dict[str, str], tests: Dict[str, Any], diff: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """The learning round's scores, each from evidence: what you said while you read, the questions you asked, the
    grading tests for the parts you reached, how far you got, and how you talked. Also the context for improvements."""
    parts = state.get("parts") or []
    reading_end = parts[0]["at"] if parts else None
    first_edit = (state.get("coding") or {}).get("first_edit")
    spoken = state.get("spoken", [])
    asked = [q for q in state.get("questions", []) if q.get("source") != "interviewer" and q.get("question")]
    # Ten minutes is too short to explain all of the library while you read, so what you explain as you use it counts too.
    said = " ".join([s["text"] for s in spoken] + [q["question"] for q in asked])
    concepts = interview.meta.get("concepts", {})
    lowered = (said + " " + notes["plan"]).lower()
    mentions = lambda word: re.search(rf"(?<!\w){re.escape(word)}", lowered) is not None   # from the start of a word: "because" isn't "cause"
    covered = [name for name, words in concepts.items() if any(mentions(word) for word in words)]
    missed_concepts = [name for name in concepts if name not in covered]
    scores: Dict[str, Any] = {}

    if len(said.split()) < 15 and not covered:
        scores["understanding"] = (None, [f"Nothing was said or written about {interview.library}, so how you understood it wasn't observed."])
    else:
        points = 1 + 4 * len(covered) / max(1, len(concepts))
        evidence = [f"Out loud or in your notes, you covered {len(covered)} of {interview.library}'s {len(concepts)} main ideas"
                    + (": " + "; ".join(covered) + "." if covered else ".")]
        if missed_concepts:
            evidence.append("Never mentioned: " + "; ".join(missed_concepts) + ".")
        if first_edit is not None and first_edit < 120 and (reading_end is None or first_edit < reading_end):
            points -= 1
            evidence.append(f"You started changing code {first_edit:.0f} seconds in, before you'd read the docs.")
        scores["understanding"] = (_clamp(points), evidence)

    in_docs = {e["topic"]: e["docs"] for e in interview.clarifications() if e.get("docs")}
    open_topics = {e["topic"] for e in interview.clarifications() if not e.get("docs")}
    from_docs = [q for q in asked if q.get("topic") in in_docs]
    open_ones = [q for q in asked if q.get("topic") in open_topics]
    coverage = interviewer.topics_covered(interview, asked, notes["assumptions"] + " " + notes["plan"])
    if not asked:
        scores["questions"] = (1, ["You didn't ask the interviewer anything. In a learning round, a few targeted questions are part of the signal."])
    else:
        points = 2 + min(2, len(open_ones)) + (1 if coverage["covered"] else 0) - (1 if len(from_docs) > 3 else 0)
        evidence = [f"You asked {len(asked)} question(s): {len(from_docs)} the docs answer, {len(open_ones)} they don't."]
        if from_docs:
            evidence.append("The docs answered: " + "; ".join(sorted({f'{q["topic"]} (section {in_docs[q["topic"]]})' for q in from_docs})) + ".")
        if coverage["covered"]:
            evidence.append("You asked about: " + "; ".join(coverage["covered"]) + ".")
        if coverage["missed"]:
            evidence.append("You didn't ask about: " + "; ".join(coverage["missed"]) + ".")
        scores["questions"] = (_clamp(points), evidence)

    reached = {f"part{i + 1}" for i in range(len(parts))}
    graded = {area: bucket for area, bucket in tests["by_area"].items() if area in reached}
    if not graded:
        scores["applying"] = (None, [f"You didn't get to the first part, so how you applied {interview.library} wasn't observed."])
    else:
        passed, total = sum(b["passed"] for b in graded.values()), sum(b["total"] for b in graded.values())
        scores["applying"] = (_band(passed / total), [f"Grading tests for the parts you reached: {passed} of {total} passed."]
                              + [f"Part {area[4:]}: {b['passed']}/{b['total']}." for area, b in sorted(graded.items())])

    done = [p for p in parts if p["done_at"] is not None and not p["skipped"]]
    skipped = [p for p in parts if p["skipped"]]
    if not parts:
        scores["pace"] = (None, ["You didn't reach the first part."])
    else:
        runs = state.get("test_runs", [])
        evidence = [f"You finished {len(done)} of {len(interview.parts())} parts" + (f" and moved on from {len(skipped)} without passing" if skipped else "") + "."]
        for i, part in enumerate(parts):
            stop = part["done_at"]
            ran = sum(1 for run in runs if part["at"] <= run["at"] and (stop is None or run["at"] <= stop))
            evidence.append(f"Part {i + 1}: " + (f"{(stop - part['at']) / 60:.0f} minutes, " if stop is not None else "not finished, ")
                            + f"{ran} test run{'' if ran == 1 else 's'}.")
        building = next((p["end"] - p["start"] for p in interview.phases() if p.get("kind") == "coding"), None)
        evidence.append(f"In {building} minutes of building, three parts is a solid pace and all four is strong.")
        scores["pace"] = (LEARNING_PACE[min(len(done), len(LEARNING_PACE) - 1)], evidence)

    talked = " ".join(s["text"] for s in spoken)
    honest = len(HONEST.findall(talked.lower()))
    early = _cue_at(state, "pl_wrap_early")   # the parts ended with time to spare, so the interviewer took your questions
    theirs = [q for q in asked if early is not None and q["at"] >= early]
    if not talked.strip() and not asked:
        scores["communication"] = (None, ["Nothing was said aloud or typed to the interviewer."])
    else:
        checks = [("talked through your thinking (150+ words)", len(talked.split()) >= 150),
                  ("said when you weren't sure, or that you'd check", honest > 0),
                  (f"explained how {interview.library} works as you used it", bool(covered))]
        if early is not None:
            checks.append(("asked the interviewer questions at the end", bool(theirs)))
        present, missing = [label for label, ok in checks if ok], [label for label, ok in checks if not ok]
        evidence = [f"You said {len(talked.split())} words in all."] + (["You " + "; ".join(present) + "."] if present else []) + (["Missing: " + "; ".join(missing) + "."] if missing else [])
        scores["communication"] = (_clamp(1 + 4 * len(present) / len(checks)), evidence)
    return scores, {"concepts_missed": missed_concepts, "questions_missing": coverage["missed"], "from_docs": len(from_docs), "parts_done": len(done)}


LEARNING_IMPROVEMENTS = {
    "understanding": "Read a section, then say in one sentence what it means before you use it.{concepts}",
    "questions": "Ask fewer, sharper questions: check the docs first, then ask about what they don't cover, such as {topics}.",
    "applying": "Before you use {thing}, say what it returns, what it raises, and when it runs, and check that against its section of the docs.",
    "pace": "Get each part working in the smallest step that passes its example test, run the tests, and only then improve it.",
    "communication": "Narrate your mental model as you go, and say \"I'm not sure, let me check\" instead of guessing: the interviewer can only correct what they hear.",
}


def _improvement(area: str, context: Dict[str, Any]) -> str:
    if context["interview"].meta.get("format") == "resume":
        return RESUME_IMPROVEMENTS.get(area, "")
    if context["interview"].meta.get("format") == "palantir-learning" and area in LEARNING_IMPROVEMENTS:
        learned = context.get("learning", {})
        missed = learned.get("concepts_missed", [])[:3]
        return LEARNING_IMPROVEMENTS[area].format(concepts=f" The ideas you didn't explain back: {'; '.join(missed)}." if missed else "",
                                                  topics="; ".join(learned.get("questions_missing", [])[:2]) or "what to do with errors the task doesn't mention",
                                                  thing="a " + context["interview"].learning("thing", f"{context['interview'].library} call"))
    if area == "problem_understanding":
        missed = context["coverage"]["missed"][:3]
        return ("Spend the first five minutes on questions. You did not clarify: " + "; ".join(missed) + ". Ask about each, or write your assumption down.") if missed else "Write your assumptions down explicitly, one line each, before you start coding."
    if area == "repository_exploration":
        files = ", ".join(context["interview"].meta.get("source_files", [])[:4])
        return f"Before editing, write a 3–5 bullet plan that traces the call path through the files you will touch ({files}) and names where state can be left half-changed."
    if area == "ai_instructions":
        missing = context["prompt_missing"]
        example = context["interview"].meta.get("source_files", ["the file"])[-1]
        return (f"Make your prompts to the assistant more specific; you never {'; '.join(missing[:3])}. For example: “In {example}, explain why this test fails, propose a fix as a diff, and don't change the tests.”") if missing else "Keep giving specific prompts, and ask the assistant for a plan before each non-trivial change."
    if area == "verification":
        if not context["patch"]["written"] or len(context["patch"]["found"]) < context["patch"]["needed"]:
            return "Review AI output against failure paths, not just the happy path. The patch you reviewed had this problem: " + context["patch"]["expected"]
        return "Run the tests after every change the assistant makes, and read each diff before accepting it."
    if area == "correctness":
        missed = [m["description"] for m in context["tests"]["missed"][:3]]
        return "Cover the cases you missed: " + "; ".join(missed) + "." if missed else "Keep checking boundaries (empty input, exact limits, repeated calls) before you submit."
    if area == "testing":
        if not context["tests"]["added"]:
            return "Write a failing regression test for each bug before fixing it, and keep it in the suite."
        return f"Make each regression test fail on the original code first: {len(context['tests']['detecting'])} of your {len(context['tests']['added'])} new tests did. Reset a copy of the workspace to check."
    if area == "code_quality":
        return ("Clean up before submitting: " + "; ".join(context["smells"]) + ".") if context["smells"] else "Keep the diff focused: small helpers, clear names, and no unrelated changes."
    if area == "leadership":
        missing = context.get("leadership_missing", [])
        return ("Tighten your STAR stories: " + "; ".join(missing[:3]) + ". Keep each story about what you did (“I”), end with a measurable result, and close with what you learned.") if missing else "Prepare 8–12 STAR stories mapped to different Leadership Principles, since each round asks for new ones."
    if area == "depth":
        return RESUME_IMPROVEMENTS["depth"]
    if area == "star":
        return "Give every story all four STAR parts: one or two sentences of situation and task, most of the time on your own actions, then the result."
    if area == "impact":
        return "Make the stories yours and measurable: say “I” for what you did, and end each one with a number (time saved, users, percent, grade)."
    if area == "followups":
        return "Expect three follow-ups per story. Prepare the details behind each one: what you did, how you measured it, and what you'd change."
    if area == "self_awareness":
        return "End each story with what you learned or would do differently, and prepare at least one story about a real mistake."
    if area == "communication" and context["interview"].meta.get("format") == "amazon-behavioral":
        return "Keep each story to about 2–3 minutes (300–450 words), and prepare two questions to ask the interviewer at the end."
    if area == "problem_solving" and context.get("optimization"):   # the coding round: what the interviewer had to push for
        return context["optimization"]
    if area == "problem_solving":
        missing = context.get("solving_missing", [])
        return ("Before you code, say your approach and its complexity, and how it beats brute force. You never: " + "; ".join(missing[:3]) + ".") if missing else "Practice stating time and space complexity in one sentence before writing any code."
    if area == "communication" and context["interview"].meta.get("format") in ("amazon-final", "amazon-coding"):
        missing = context["communication_missing"]
        return ("Narrate while you code: " + "; ".join(missing[:3]) + ".") if missing else "Prepare two or three questions about the team to ask at the end."
    if area == "communication":
        missing = context["communication_missing"]
        return ("In your final explanation, also cover " + "; ".join(missing) + ".") if missing else "Practice saying your explanation out loud in under two minutes."
    return ""


NOT_OBSERVED_HELP = {
    "understanding": "Explain the library out loud (mic) or in the chat as you read and use it, so your understanding can be assessed.",
    "applying": "Press Ready for the task once you've read the docs, so you get to the parts.",
    "pace": "Press Ready for the task once you've read the docs, so you get to the parts.",
    "walkthrough": "Answer the interviewer's first question out loud (mic) or in the chat, so your background walkthrough can be assessed.",
    "depth": "Answer the résumé deep-dive questions out loud (mic) or in the chat, so the interviewer can ask how your projects work.",
    "leadership": "Answer the interviewer's Leadership Principles questions out loud (mic) or in the chat, so they can be assessed.",
    "problem_solving": "Say or write your approach and its time and space complexity, so problem solving can be assessed.",
    "problem_understanding": "Ask clarification questions in the dashboard and record your assumptions, so problem understanding can be assessed.",
    "repository_exploration": "Write your plan in the dashboard (which files, which call path, what you will change), so exploration can be assessed.",
    "ai_instructions": "Paste your Claude Code transcript into the Transcript box (Claude Code's /export copies it), so your instructions to the assistant can be assessed.",
    "verification": "Run the tests from the dashboard and write the patch review, so verification can be assessed.",
    "code_quality": "Make your changes in the workspace folder the dashboard shows, so the diff can be assessed.",
    "communication": "Write the final explanation (what you changed, why, tradeoffs, what is left), so communication can be assessed.",
}


def grade(interview: Interview, home: Path, sessions: Sessions) -> Dict[str, Any]:
    state = sessions.load(interview.id)
    if not state:
        raise ValueError("Start the interview before submitting.")
    workspace = workspace_path(interview, home)
    notes = {key: state.get("notes", {}).get(key, "") for key in ("plan", "assumptions", "patch_review", "explanation", "transcript")}
    spoken = state.get("spoken", [])
    notes["spoken"] = "\n".join(s["text"] for s in spoken)
    notes["spoken_late"] = "\n".join(s["text"] for s in spoken if s["at"] >= 40 * 60)
    review_file = workspace / "patch_review" / "my_review.md"
    if review_file.exists():
        notes["patch_review"] = (notes["patch_review"] + "\n\n" + review_file.read_text(encoding="utf-8")).strip()

    behavioral_only = interview.meta.get("format") in CONVERSATION_FORMATS
    resume_round = interview.meta.get("format") == "resume"
    runs = {"hidden": {"ok": True, "returncode": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "total": 0, "cases": [], "output": ""}, "own": None, "own_on_starter": None, "starter_names": set()} if behavioral_only else _run_all(interview, home)
    tests = _test_evidence(interview, runs)
    raw_diff = diff_against_starter(interview, home)
    diff = _diff_evidence(interview, raw_diff)
    patch = _patch_review(interview, notes["patch_review"])
    revealed_at = state.get("change_revealed_at")

    pu_score, pu_evidence, coverage = _score_problem_understanding(interview, state, notes)
    ex_score, ex_evidence = _score_exploration(interview, notes)
    ai_score, ai_evidence, prompt_missing = _score_ai_instructions(notes)
    ve_score, ve_evidence = _score_verification(state, notes, patch, revealed_at)
    co_score, co_evidence = _score_correctness(runs, tests)
    te_score, te_evidence = _score_testing(runs, tests, diff)
    cq_score, cq_evidence, smells = _score_code_quality(diff)
    cm_score, cm_evidence, communication_missing = _score_communication(interview, notes)
    scores = {
        "problem_understanding": (pu_score, pu_evidence),
        "repository_exploration": (ex_score, ex_evidence),
        "ai_instructions": (ai_score, ai_evidence),
        "verification": (ve_score, ve_evidence),
        "correctness": (co_score, co_evidence),
        "testing": (te_score, te_evidence),
        "code_quality": (cq_score, cq_evidence),
        "communication": (cm_score, cm_evidence),
    }
    context = {"interview": interview, "coverage": coverage, "prompt_missing": prompt_missing, "patch": patch, "tests": tests, "smells": smells, "communication_missing": communication_missing}
    amazon = interview.meta.get("format") == "amazon-final"
    problem = interview.meta.get("format") == "problem"
    coding_round = interview.meta.get("format") == "amazon-coding"
    if amazon or problem or coding_round:
        lp_score, lp_evidence, context["leadership_missing"] = _score_leadership(interview, state) if amazon else (None, [], [])
        ps_score, ps_evidence, context["solving_missing"] = _score_problem_solving(interview, notes, runs)
        cm_score, cm_evidence, context["communication_missing"] = _score_amazon_communication(interview, state, notes)
        dry_run = re.search(r"\b(dry run|walk(ing)? through|trace|let's try|for example|edge case)", (notes["spoken"] + " " + notes["explanation"]).lower())
        test_runs, code_runs = state.get("test_runs", []), state.get("code_runs", [])
        te_score = _clamp((te_score or 1) + (1 if dry_run else 0) + (1 if test_runs or code_runs else 0))
        te_evidence = te_evidence + (["You walked through an example or edge case by hand."] if dry_run else ["No dry run was said or written. Interviewers expect you to trace the example before running anything."])
        te_evidence.append(f"Ran the tests {len(test_runs)} time(s) and your own code {len(code_runs)} time(s) in the editor." if test_runs or code_runs else "Never ran the tests or your own code in the editor.")
        if problem:
            # Hints: noted in coach mode; in real mode, leaning on them lowers the problem-solving score.
            hints, coached = state.get("hints", []), state.get("mode") == "coach"
            real_hints = [h for h in hints if h.get("mode") != "coach"]
            if hints:
                ps_evidence = ps_evidence + [f"Used {len(hints)} of {len(interview.hints())} hints" + (f" ({len(real_hints)} in real mode, which lowers this score)." if real_hints else " in coach mode (not penalized).")]
            if real_hints and ps_score is not None:
                ps_score = _clamp(ps_score - (len(real_hints) - 1 if len(real_hints) > 1 else 0) - (1 if len(real_hints) >= len(interview.hints()) else 0))
            if state.get("approach_revealed") and ps_score is not None:
                ps_score = min(ps_score, 3)
                ps_evidence = ps_evidence + ["You opened the reference approach, so this score is capped at 3. Re-solve it in real mode to earn the rest."]
        if coding_round:
            # How much the interviewer had to help: the push for a faster version, and hints (the first one is free).
            lines, penalty, context["optimization"] = optimization_evidence(interview, state)
            used = {stage: [h for h in state.get("hints", []) if h.get("stage", "main") == stage] for stage in ("main", "followup")}
            if used["main"] or used["followup"]:
                stuck = sum(1 for h in state.get("hints", []) if h.get("reason") == "stuck")
                lines.append(f"Used {len(used['main'])} of {len(interview.hints())} hints on the problem and {len(used['followup'])} of {len(interview.followup_hints())} on the follow-up"
                             + (f" ({stuck} offered when you were stuck)" if stuck else "") + ". Past the first, each one lowers this score.")
                penalty += max(0, len(used["main"]) - 1) + (1 if len(used["main"]) >= len(interview.hints()) else 0) + (1 if interview.followup_hints() and len(used["followup"]) >= len(interview.followup_hints()) else 0)
            ps_evidence = ps_evidence + lines
            if ps_score is not None:
                ps_score = _clamp(ps_score - penalty)
        scores.update({"leadership": (lp_score, lp_evidence), "problem_solving": (ps_score, ps_evidence), "communication": (cm_score, cm_evidence), "testing": (te_score, te_evidence)})
    if resume_deep_dive(interview):
        saved = resume.load(home)
        scores["depth"] = _score_resume_deep_dive(interview, state, saved["text"] if saved else "")
    if resume_round:
        saved = resume.load(home)
        scores.update(_resume_scores(interview, state, saved["text"] if saved else ""))
    elif behavioral_only:
        scores.update(_behavioral_scores(interview, state, notes))
        context["leadership_missing"] = _score_leadership(interview, state)[2]
    learning = interview.meta.get("format") == "palantir-learning"
    if learning:
        learned, context["learning"] = _learning_scores(interview, state, notes, tests, diff)
        scores.update(learned)
    areas = areas_for(interview)
    observed = sorted((area for area, _ in areas if scores[area][0] is not None), key=lambda a: (scores[a][0], [x for x, _ in areas].index(a)))
    improvements = [_improvement(area, context) for area in observed if scores[area][0] < 5][:3]
    for area, _ in areas:
        if len(improvements) >= 3:
            break
        if scores[area][0] is None and area in NOT_OBSERVED_HELP:
            improvements.append(NOT_OBSERVED_HELP[area])
    while len(improvements) < 3:
        improvements.append(["Try the follow-up exercise below under a 20-minute timer.", "Repeat this interview after a week without looking at your previous diff.", "Try a different interview from the lab to practice an unfamiliar domain."][len(improvements) % 3])
    weakest = observed[0] if observed else areas[0][0]  # nothing observed: practice the round's main skill
    follow_up = {"area": weakest, "label": LABELS[weakest], "exercise": interview.meta.get("followups", {}).get(weakest, "")}

    assumptions = []
    failed_topics = {m["topic"] for m in tests["missed"] if m.get("topic")}
    for topic in coverage["missed"]:
        if topic in failed_topics:
            cases = [m["description"] for m in tests["missed"] if m.get("topic") == topic]
            assumptions.append(f"You did not clarify “{topic}”, and the related cases failed: " + "; ".join(cases[:3]) + ".")
    for item in diff["weakened"]:
        assumptions.append(f"Assumed the visible tests in {item['path']} were wrong and {'deleted them' if item['deleted'] else 'removed assertions'}; that needs the interviewer's agreement.")
    for path in diff["data_edits"]:
        assumptions.append(f"Edited {path}, assuming the input data could be changed; real supplier or customer data usually cannot.")
    if revealed_at is None and interview.meta.get("change_at_minutes", 30) is not None:
        assumptions.append("Submitted before the interviewer's follow-up was revealed, so it was not addressed." if amazon or coding_round else "Submitted before the requirement change was revealed, so the change was not addressed.")
    elif tests["by_area"].get("change", {}).get("passed", 0) == 0 and tests["by_area"].get("change"):
        assumptions.append("The interviewer's follow-up was revealed but none of its cases pass." if coding_round else "The requirement change was revealed but none of its cases pass.")

    elapsed = sessions.elapsed(state)
    report = {
        "interview": interview.id,
        "title": interview.title,
        "submitted": datetime.now().isoformat(timespec="seconds"),
        "elapsed_minutes": round(elapsed / 60, 1),
        "change_revealed_at_minutes": None if revealed_at is None else round(revealed_at / 60, 1),
        "timeline": time_breakdown(interview, state, elapsed),
        "tests": {
            "grading": summary(runs["hidden"]),
            "grading_by_area": tests["by_area"],
            "your_tests": summary(runs["own"]) if runs["own"] else None,
            "your_new_tests": len(tests["added"]),
            "your_tests_that_catch_starter_bugs": len(tests["detecting"]),
            "grading_output": runs["hidden"]["output"][-3000:],
        },
        "scores": [{"area": area, "label": label, "score": scores[area][0], "evidence": scores[area][1]} for area, label in areas],
        "missed_cases": [f"[{m['area']}] {m['description']}" for m in tests["missed"]],
        "questionable_assumptions": assumptions,
        "improvements": improvements,
        "follow_up": follow_up,
        "patch_review": {"found": patch["found"], "needed": patch["needed"], "answer": patch["expected"]} if patch["expected"] else None,
        "format_note": ("A conversation about your résumé, scored from what you said. The scores are heuristics; the interviewer's written notes below are the fuller picture." if resume_round
                        else "A learning round, scored from what you said, asked, and built. The scores are heuristics; the interviewer's written notes below are the fuller picture." if learning
                        else "No AI in this round: Amazon tells candidates not to use GenAI tools during interviews unless explicitly permitted, so the AI areas are not scored." if amazon or behavioral_only or coding_round
                        else (f"Coach mode: you used {len(state.get('hints', []))} hint(s){' and opened the reference approach' if state.get('approach_revealed') else ''}. Try it again in real mode once it feels easy." if problem and state.get("mode") == "coach"
                              else (f"Real mode: {len(state.get('hints', []))} hint(s) used." if problem else None))),
        "mode": state.get("mode", "real") if problem else None,
        "hints_used": len(state.get("hints", [])) if problem or coding_round or learning else None,
        "help": interviewer_help(interview, state) if coding_round or learning else None,
        "approach": interview.approach() if problem else _guide_approach(interview) if coding_round else interview.guide_section("The parts") if learning else None,
        "parts": [{"title": title, "done": i < len(state.get("parts", [])) and state["parts"][i]["done_at"] is not None and not state["parts"][i]["skipped"],
                   "reached": i < len(state.get("parts", []))} for i, title in enumerate(part["title"] for part in interview.parts())] if learning else None,
        "notes_by": "learning" if learning else "resume" if resume_round else None,
        "lp_breakdown": ([{"lp": story["lp"], "question": story["question"], "score": story["score"], "missing": story["missing"]} for story in resume_principles(interview, state)]
                         if resume_round else lp_breakdown(interview, state) if amazon or behavioral_only else None),
        "behavioral_only": behavioral_only,
        "changed_files": [{"path": f["path"], "status": f["status"], "added": len(f["added_lines"]), "removed": len(f["removed_lines"])} for f in raw_diff["files"]],
        "ai_usage_note": "Coding-assistant usage through the Claude Code app counts toward your Claude subscription and is not measured or scored here.",
        "disclaimer": DISCLAIMER,
    }
    folder = home / ".lab" / "submissions" / interview.id / time.strftime("%Y%m%d-%H%M%S")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (folder / "report.md").write_text(render_markdown(report), encoding="utf-8")
    (folder / "diff.patch").write_text(raw_diff["text"], encoding="utf-8")
    (folder / "grading_prompt.md").write_text(grading_prompt(interview, report, raw_diff["text"], notes, state), encoding="utf-8")
    report["saved_to"] = str(folder)
    (folder / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def latest_report(interview: Interview, home: Path) -> Tuple[Optional[Dict[str, Any]], Optional[Path]]:
    folder = home / ".lab" / "submissions" / interview.id
    reports = sorted(folder.glob("*/report.json")) if folder.exists() else []
    if not reports:
        return None, None
    return json.loads(reports[-1].read_text(encoding="utf-8")), reports[-1].parent


def _cue_at(state: Dict[str, Any], *names: str) -> Optional[float]:
    """When the interviewer first said one of these lines, in seconds into the session."""
    kinds = {f"cue:{name}" for name in names}
    times = [q["at"] for q in state.get("questions", []) if q.get("source") == "interviewer" and q.get("kind") in kinds]
    return min(times) if times else None


def _guide_approach(interview: Interview) -> str:
    """How to solve the coding round's problem and its follow-up, from the interviewer guide, for the report."""
    parts = [("Coding problem", interview.guide_section("Coding problem")), ("The follow-up", interview.guide_section("Follow-up at"))]
    return "\n\n".join(f"**{title}.** {text}" for title, text in parts if text)


def optimization_evidence(interview: Interview, state: Dict[str, Any]) -> Tuple[List[str], int, str]:
    """The coding round: whether each working solution was fast enough on its own, after the interviewer asked for a
    faster one, or never. Returns the evidence for problem solving, how much to take off it, and the improvement to
    suggest ("" when there's nothing to say)."""
    speed, asked = state.get("speed") or {}, state.get("optimize") or {}
    minute = lambda seconds: f"minute {seconds / 60:.0f}"
    lines: List[str] = []
    penalty, improve = 0, ""
    for stage in ("main", "followup"):
        if stage == "followup" and state.get("change_revealed_at") is None:
            break
        checks = speed.get(stage, [])
        working = [c for c in checks if c["status"] in ("fast", "slow")]
        fast = next((c for c in checks if c["status"] == "fast"), None)
        what = "Your solution" if stage == "main" else "Your follow-up"
        if not working:
            lines.append(f"{what} never passed its example test while the interviewer was watching, so its speed wasn't checked.")
        elif stage not in asked:
            lines.append(f"{what} was fast enough as soon as it worked ({minute(working[0]['at'])}), so the interviewer didn't have to ask for a faster one.")
        elif fast and fast["at"] >= asked[stage]:
            lines.append(f"{what} was too slow at first. The interviewer asked for a faster one at {minute(asked[stage])}, and you had it by {minute(fast['at'])}.")
            improve = improve or ("Find the faster approach before you code: ask yourself what work your first idea repeats, and say each idea's complexity out loud. "
                                  "This time the interviewer had to push for it.")
        else:
            lines.append(f"{what} stayed slower than it needed to be after the interviewer asked for a faster one at {minute(asked[stage])}.")
            penalty += 1
            improve = ("You didn't get past the slower version. Re-solve this problem until you find the faster approach on your own, then practice two more "
                       "problems that use the same idea.")
    return lines, penalty, improve


def interviewer_help(interview: Interview, state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Each time the interviewer stepped in (the coding round, and the learning round), oldest first: hints, check-ins
    when you'd gone quiet, nudges when the same tests kept failing, and asks for a faster or a working version."""
    minute = lambda seconds: round(seconds / 60, 1)
    totals = {"main": len(interview.hints()), "followup": len(interview.followup_hints()), **{f"part{i + 1}": len(part["hints"]) for i, part in enumerate(interview.parts())}}
    where = lambda stage: " for the follow-up" if stage == "followup" else f" on part {stage[4:]}" if stage.startswith("part") else ""
    items = [{"at": minute(h["at"]), "kind": "hint", "text": f"Hint {h['level']} of {totals.get(h.get('stage', 'main'), h['level'])}"
              + where(h.get("stage", "main")) + (", when you seemed stuck" if h.get("reason") == "stuck" else ", when you asked")}
             for h in state.get("hints", [])]
    for at, kind in Sessions.help_given(state):
        if kind == "checkin":
            items.append({"at": minute(at), "kind": "checkin", "text": "Checked in after you'd gone quiet"})
        elif kind == "debug":
            items.append({"at": minute(at), "kind": "debug", "text": "Suggested tracing a failing test by hand, after the same tests kept failing"})
    for stage, at in (state.get("optimize") or {}).items():
        items.append({"at": minute(at), "kind": "optimize", "text": "Asked for a faster version" + (" of the follow-up" if stage == "followup" else "")})
    for stage, at in (state.get("verify") or {}).items():
        items.append({"at": minute(at), "kind": "verify", "text": f"Asked you to run the tests before moving on from part {stage[4:]}, which didn't pass yet" if stage.startswith("part")
                      else "Asked you to test it, when you said you were done" + (" with the follow-up" if stage == "followup" else "") + " but it didn't work yet"})
    return sorted(items, key=lambda item: item["at"])


def _coding_round_time(interview: Interview, state: Dict[str, Any], elapsed: float) -> Dict[str, Any]:
    """The coding round against the clock: your approach, the first version, making it faster, the follow-up, and the
    wrap-up, each next to its planned length, with notes on your pacing and on how much help you needed."""
    phases = interview.phases()
    span = lambda phase: (phase["end"] - phase["start"]) if phase else None
    code_phase = next((p for p in phases if p.get("kind") == "coding"), None)
    wrap_phase = next((p for p in phases if p.get("kind") == "wrap"), None)
    coding = state.get("coding") or {}
    first_edit = coding.get("first_edit")
    wrap_at = _cue_at(state, "ac_wrap", "ac_wrap_early")
    followup_at = state.get("change_revealed_at")
    speed, asked = state.get("speed") or {}, (state.get("optimize") or {}).get("main")
    fast_at = next((c["at"] for c in speed.get("main", []) if c["status"] == "fast"), None)
    change_at = interview.meta.get("change_at_minutes")
    first = lambda *times: next((t for t in times if t is not None), None)
    minutes = lambda seconds: round(seconds / 60, 1)
    parts: List[Dict[str, Any]] = []

    def part(label: str, start: Optional[float], stop: Optional[float], planned: Optional[float]) -> None:
        if start is not None:
            parts.append({"part": label, "start": minutes(start), "minutes": minutes(max(0.0, (elapsed if stop is None else stop) - start)), "planned": planned})

    part("Clarifying and your approach", 0.0, first(first_edit, wrap_at), span(phases[0]) if phases else None)
    coding_minutes = None
    if first_edit is not None:
        planned = change_at - code_phase["start"] if code_phase and change_at is not None else span(code_phase)
        if asked is not None:
            part("Coding a first version", first_edit, asked, planned)
            part("Making it faster", asked, first(fast_at if fast_at is not None and fast_at >= asked else None, followup_at, wrap_at), None)
        else:
            part("Coding it", first_edit, first(followup_at, wrap_at), planned)
        if followup_at is not None:
            part("The follow-up", followup_at, wrap_at, code_phase["end"] - change_at if code_phase and change_at is not None else None)
        coding_minutes = minutes(first(wrap_at, elapsed) - first_edit)
    part("Wrap-up and your questions", wrap_at, None, span(wrap_phase))

    notes: List[str] = []
    said_before = " ".join(s["text"] for s in state.get("spoken", []) if first_edit is None or s["at"] < first_edit).lower()
    if first_edit is None:
        notes.append("You didn't write any code in the editor.")
    else:
        lag = first_edit / 60
        if lag > 10:
            notes.append(f"You started coding {lag:.0f} minutes in. Settle on an approach within 5–8 minutes: you can code the simple version and improve it after.")
        elif not COMPLEXITY.search(said_before):
            notes.append(f"You started coding {lag:.0f} minute{'' if round(lag) == 1 else 's'} in without saying your approach's complexity. Give the interviewer the approach and its time and space complexity first.")
    if asked is not None and fast_at is not None and fast_at >= asked:
        notes.append(f"Making it faster took {(fast_at - asked) / 60:.0f} minutes after the interviewer asked.")
    elif asked is None and fast_at is not None:
        notes.append("Your first working version was already fast enough, so no time went to optimizing.")
    if followup_at is None and first_edit is not None:
        notes.append("The round never reached the follow-up. Get a working version early, so there's time to improve it and extend it.")
    help_items = interviewer_help(interview, state)
    hints, checkins = [h for h in help_items if h["kind"] == "hint"], [h for h in help_items if h["kind"] in ("checkin", "debug")]
    if hints or checkins:
        notes.append(f"The interviewer stepped in {len(hints) + len(checkins)} time{'s' if len(hints) + len(checkins) != 1 else ''}: "
                     f"{len(checkins)} check-in{'s' if len(checkins) != 1 else ''} and {len(hints)} hint{'s' if len(hints) != 1 else ''}. "
                     "When you're stuck, say what you're considering out loud: it lets the interviewer help with less.")
    if wrap_at is None and first_edit is not None:
        notes.append("The round never reached the wrap-up. Leave the last 5–10 minutes for the complexity and follow-up questions.")
    elif wrap_at is not None and (elapsed - wrap_at) / 60 < 3:
        spent = (elapsed - wrap_at) / 60
        amount = "Less than a minute" if spent < 1 else "Only about a minute" if spent < 1.5 else f"Only {spent:.0f} minutes"
        notes.append(f"{amount} went to the wrap-up; aim for 5–10, for the complexity, the follow-up questions, and yours.")
    if not notes:
        notes.append("Your pacing kept to the plan.")
    return {"duration": interview.meta.get("duration_minutes"), "parts": parts, "stories": [], "story_share": None, "coding_minutes": coding_minutes, "notes": notes}


def _learning_time(interview: Interview, state: Dict[str, Any], elapsed: float) -> Dict[str, Any]:
    """The learning round against the clock: reading, each part, and the wrap-up when the parts ended with time to
    spare, with notes on your pacing and on how much help you needed."""
    phases = interview.phases()
    span = lambda kind: next(((p["end"] - p["start"]) for p in phases if p.get("kind") == kind), None)
    parts = state.get("parts") or []
    stopped = _cue_at(state, "pl_wrap", "pl_wrap_early")   # time ran out, or the parts ended early
    early = _cue_at(state, "pl_wrap_early")
    minutes = lambda seconds: round(seconds / 60, 1)
    rows: List[Dict[str, Any]] = []

    def part(label: str, start: Optional[float], stop: Optional[float], planned: Optional[float]) -> None:
        if start is not None:
            rows.append({"part": label, "start": minutes(start), "minutes": minutes(max(0.0, (elapsed if stop is None else stop) - start)), "planned": planned})

    part("Reading the docs", 0.0, parts[0]["at"] if parts else stopped, span("learn"))
    for i, revealed in enumerate(parts):
        following = parts[i + 1]["at"] if i + 1 < len(parts) else None
        part(f"Part {i + 1}" + (" (moved on)" if revealed["skipped"] else ""), revealed["at"], revealed["done_at"] or following or stopped, None)
    part("Wrap-up and your questions", early, None, None)   # no time is set aside for it

    notes: List[str] = []
    total = len(interview.parts())
    if not parts:
        notes.append("The round never got to the first part. Press Ready for the task once you've read the docs.")
    else:
        if parts[0]["at"] < 0.4 * (span("learn") or 0) * 60:
            read = parts[0]["at"] / 60
            took = "less than a minute" if read < 1 else f"{read:.0f} minute{'s' if round(read) != 1 else ''}"
            notes.append(f"You asked for the first part after {took} of reading. Read a little longer: most mistakes in this round come from guessing at the library.")
        done = [p for p in parts if p["done_at"] is not None and not p["skipped"]]
        notes.append(f"You finished {len(done)} of {total} parts." + (" Not finishing is normal; how you got there counts more." if len(done) < total else ""))
    help_items = interviewer_help(interview, state)
    hints, checkins = [h for h in help_items if h["kind"] == "hint"], [h for h in help_items if h["kind"] in ("checkin", "debug")]
    if hints or checkins:
        notes.append(f"The interviewer stepped in {len(hints) + len(checkins)} time{'s' if len(hints) + len(checkins) != 1 else ''}: "
                     f"{len(checkins)} check-in{'s' if len(checkins) != 1 else ''} and {len(hints)} hint{'s' if len(hints) != 1 else ''}.")
    return {"duration": interview.meta.get("duration_minutes"), "parts": rows, "stories": [], "story_share": None,
            "coding_minutes": minutes((stopped or elapsed) - parts[0]["at"]) if parts else None, "notes": notes}


def time_breakdown(interview: Interview, state: Dict[str, Any], elapsed: float) -> Optional[Dict[str, Any]]:
    """The Amazon rounds against the clock: how long each part took next to its planned length, how long each
    Leadership Principles story ran, how long you coded, and what to change about your pacing."""
    fmt = interview.meta.get("format")
    if fmt == "amazon-coding":
        return _coding_round_time(interview, state, elapsed)
    if fmt == "palantir-learning":
        return _learning_time(interview, state, elapsed)
    if fmt not in ("amazon-final", "amazon-behavioral"):
        return None
    phases = interview.phases()
    span = lambda phase: (phase["end"] - phase["start"]) if phase else None
    find = lambda **match: next((p for p in phases if all(p.get(k) == v for k, v in match.items())), None)
    final = fmt == "amazon-final"
    lp_phase, wrap_phase = find(kind="behavioral"), find(kind="wrap")
    clarify_phase, code_phase = find(cue="amz_clarify"), find(cue="amz_code")
    answers = [a for a in state.get("behavioral", {}).get("answers", []) if a.get("asked_at") is not None]
    problem_at = _cue_at(state, "amz_clarify") if final else None
    wrap_at = _cue_at(state, *(["amz_wrap", "amz_wrap_early"] if final else [wrap_phase["cue"]] if wrap_phase and wrap_phase.get("cue") else []))
    coding = state.get("coding") or {}
    first_edit, done = coding.get("first_edit"), (coding.get("done") or [None])[-1]
    followup_at = state.get("change_revealed_at")
    minutes = lambda seconds: round(seconds / 60, 1)
    parts: List[Dict[str, Any]] = []

    def part(label: str, start: Optional[float], stop: Optional[float], planned: Optional[float]) -> None:
        if start is not None:
            parts.append({"part": label, "start": minutes(start), "minutes": minutes(max(0.0, (elapsed if stop is None else stop) - start)), "planned": planned})

    lp_start = answers[0]["asked_at"] if answers else None
    lp_stop = problem_at if final else wrap_at
    part("Introductions", 0.0, lp_start if lp_start is not None else lp_stop, span(phases[0]) if phases and phases[0].get("kind") == "intro" else None)
    part("Leadership Principles", lp_start, lp_stop, span(lp_phase))
    coding_minutes = None
    if final and problem_at is not None:
        part("Reading and clarifying", problem_at, first_edit if first_edit is not None else wrap_at, span(clarify_phase))
        if first_edit is not None:
            stop = wrap_at if wrap_at is not None else done
            change_at = interview.meta.get("change_at_minutes")
            if followup_at is not None and followup_at > first_edit and (stop is None or followup_at < stop) and code_phase and change_at is not None:
                part("Coding the problem", first_edit, followup_at, change_at - code_phase["start"])
                part("The follow-up", followup_at, stop, code_phase["end"] - change_at)
            else:
                part("Coding", first_edit, stop, span(code_phase))
            coding_minutes = minutes((elapsed if stop is None else stop) - first_edit)
    part("Dry run and your questions" if final else "Your questions", wrap_at, None, span(wrap_phase))

    plan = state.get("behavioral", {}).get("plan") or []
    share = span(lp_phase) / max(1, len(plan)) if lp_phase and plan else None
    stories = []
    for i, answer in enumerate(answers):
        stop = answers[i + 1]["asked_at"] if i + 1 < len(answers) else lp_stop
        stories.append({"lp": answer.get("lp"), "minutes": minutes((elapsed if stop is None else stop) - answer["asked_at"]), "followups": max(0, len(answer.get("prompts", [])) - 1)})

    notes: List[str] = []
    if final:
        if problem_at is None:
            notes.append("The round ended before the coding problem. Keep each story to its share of the questions' time, so you reach the code.")
        elif first_edit is None:
            notes.append("You didn't write any code in the editor.")
        else:
            lag = (first_edit - problem_at) / 60
            asked = [q for q in state.get("questions", []) if q.get("source") != "interviewer" and problem_at <= q["at"] <= first_edit]
            if lag > 7:
                notes.append(f"You started coding {lag:.0f} minutes after the problem appeared. Clarify for 3–5 minutes, then start: you can keep asking as you code.")
            elif lag < 1 and not asked:
                notes.append("You started coding within a minute of seeing the problem, without a clarifying question. Ask two or three first (input size, ties, edge cases).")
            budget = span(code_phase)
            if budget and coding_minutes is not None and coding_minutes > budget + 2:
                notes.append(f"Coding took {coding_minutes:.0f} minutes, past the {budget} planned. Get a simple version working first, then improve it, so you're never out of time with nothing that runs.")
            elif budget and coding_minutes is not None and wrap_at is not None and coding_minutes < budget * 0.6:
                notes.append(f"You finished coding in {coding_minutes:.0f} minutes, well inside the {budget} planned. Use spare time to test edge cases out loud.")
        if problem_at is not None and wrap_at is None:
            notes.append("The round never reached the dry run and your questions. Leave the last 5–10 minutes for them.")
        elif wrap_at is not None and (elapsed - wrap_at) / 60 < 3:
            spent = (elapsed - wrap_at) / 60
            amount = "Less than a minute" if spent < 1 else "Only about a minute" if spent < 1.5 else f"Only {spent:.0f} minutes"
            notes.append(f"{amount} went to the dry run and your questions; aim for 5–10.")
    for story in stories:
        if share and story["minutes"] > share + 1.5:
            notes.append(f"Your {story['lp'] or 'first'} story took {story['minutes']:.0f} minutes, past its share of about {share:.0f}. Lead with a two-minute STAR answer and let the follow-ups add detail.")
    if not notes:
        notes.append("Your pacing kept to the plan.")
    return {"duration": interview.meta.get("duration_minutes"), "parts": parts, "stories": stories, "story_share": None if share is None else round(share, 1),
            "coding_minutes": coding_minutes, "notes": notes}


def render_markdown(report: Dict[str, Any]) -> str:
    grading = report["tests"]["grading"]
    lines = [f"# {report['title']}: session report", "", f"Submitted {report['submitted']} after {report['elapsed_minutes']} minutes.", "",
             "## Test results", "", f"- Grading tests: {grading['passed']} passed, {grading['failed']} failed, {grading['errors']} errors (of {grading['total']})."]
    for area, bucket in report["tests"]["grading_by_area"].items():
        lines.append(f"  - {area}: {bucket['passed']}/{bucket['total']}")
    own = report["tests"]["your_tests"]
    if own:
        lines.append(f"- Your tests: {own['passed']} passed, {own['failed']} failed, {own['errors']} errors.")
    lines.append(f"- New tests you wrote: {report['tests']['your_new_tests']}; of those, catching starter bugs: {report['tests']['your_tests_that_catch_starter_bugs']}.")
    timeline = report.get("timeline")
    if timeline:
        lines += ["", "## Time", "", "| Part | Took | Planned |", "|---|---|---|"]
        lines += [f"| {p['part']} | {p['minutes']} min | {p['planned'] if p['planned'] is not None else '–'} min |" for p in timeline["parts"]]
        lines += [""] + [f"- {note}" for note in timeline["notes"]]
    if report.get("help") is not None:
        lines += ["", "## How the interviewer helped", ""] + ([f"- Minute {item['at']:.0f}: {item['text']}." for item in report["help"]] or ["- It didn't need to: no hints, check-ins, or pushes."])
    lines += ["", "## Scores", "", "| Area | Score |", "|---|---|"]
    lines += [f"| {s['label']} | {s['score'] if s['score'] is not None else 'not observed'} |" for s in report["scores"]]
    lines += ["", "## Evidence", ""]
    for s in report["scores"]:
        lines.append(f"**{s['label']}**")
        lines += [f"- {e}" for e in s["evidence"]]
        lines.append("")
    lines += ["## Missed cases", ""] + ([f"- {m}" for m in report["missed_cases"]] or ["- None."])
    lines += ["", "## Questionable assumptions", ""] + ([f"- {a}" for a in report["questionable_assumptions"]] or ["- None found."])
    lines += ["", "## Three improvements", ""] + [f"{i}. {text}" for i, text in enumerate(report["improvements"], 1)]
    follow = report["follow_up"]
    lines += ["", f"## Follow-up exercise ({follow['label']})", "", follow["exercise"], ""]
    if report.get("patch_review"):
        lines += ["## AI patch review", "", report["patch_review"]["answer"], ""]
    if report.get("format_note"):
        lines += [report["format_note"], ""]
    lines += ["---", report["disclaimer"], ""]
    return "\n".join(lines)


def grading_prompt(interview: Interview, report: Dict[str, Any], diff_text: str, notes: Dict[str, str], state: Dict[str, Any]) -> str:
    """A self-contained prompt for grading this session in a separate Claude conversation (no API key needed)."""
    def clip(text: str, limit: int) -> str:
        return text if len(text) <= limit else text[:limit] + f"\n… [{len(text) - limit} more characters cut]"
    questions = "\n".join(f"- [{q['at'] / 60:.0f} min] Interviewer: {q['answer']}" if q.get("source") == "interviewer" else f"- [{q['at'] / 60:.0f} min] Q: {q['question']}\n  A: {q['answer']}" for q in state.get("questions", [])) or "(none)"
    spoken = "\n".join(f"- [{s['at'] / 60:.0f} min] {s['text']}" for s in state.get("spoken", [])) or "(none)"
    auto = "\n".join(f"- {s['label']}: {s['score'] if s['score'] is not None else 'not observed'}" for s in report["scores"])
    amazon = interview.meta.get("format") == "amazon-final"
    area_names = ", ".join(label for _, label in areas_for(interview))
    problem = interview.meta.get("format") == "problem"
    hints = state.get("hints", [])
    helped = "; ".join(f"minute {item['at']:.0f}: {item['text']}" for item in (report.get("help") or [])) or "it never needed to"
    setting = ("This is a simulated Amazon SDE intern final-round interview with no AI assistant (Amazon tells candidates not to use GenAI during interviews). It has Leadership Principles questions with follow-ups, then a coding problem in an editor that can run tests."
               if amazon else ("This is a simulated Amazon SDE intern coding round with no AI assistant: one problem and a follow-up, in an editor that can run tests. The interviewer asked for the complexity, "
                               f"pushed for a faster version when a working one was too slow, and helped when the candidate was stuck ({helped}). Weigh how much help they needed." if interview.meta.get("format") == "amazon-coding"
                               else (f"This is a simulated Palantir FDSE Learning interview with no AI assistant: the candidate learned {interview.library}, {interview.learning('about', 'an internal library')}, from its docs (in the "
                                     f"interviewer guide below), and used it on a customer's tool in parts. The interviewer stepped in: {helped}. Judge how they learned, not only what they built.")
                               if interview.meta.get("format") == "palantir-learning"
                               else f"This is a single-problem practice round with no AI assistant, in {state.get('mode', 'real')} mode. The candidate used {len(hints)} hint(s){' and opened the reference approach' if state.get('approach_revealed') else ''}." if problem
                               else "The candidate used an AI coding assistant (Claude Code), which is allowed and expected."))
    ai_rule = ("- Judge Leadership Principles answers on STAR structure, personal ownership, measurable results, and how well follow-ups were handled." if amazon
               else "- Judge problem solving on whether the candidate found the faster approach alone, after the interviewer's push, or only with hints, and whether they explained its complexity." if interview.meta.get("format") == "amazon-coding"
               else "- Judge whether they read before coding, explained the library back correctly, asked purposeful questions, tested in small steps, and said when they weren't sure. Bluffing counts against them." if interview.meta.get("format") == "palantir-learning"
               else "- Do not treat using less AI as better. Judge how well the candidate directed and checked the assistant.")
    behavioral = "\n".join(f"- Q: {a['question']}" + (f" [{a['lp']}]" if a.get("lp") else "") + "".join(f"\n  Prompt: {p}" for p in a.get("prompts", [])[1:]) + "\n  Answer: " + " ".join(part["text"] for part in a.get("parts", [])) for a in state.get("behavioral", {}).get("answers", [])) or "(none)"
    return f"""You are grading a {interview.meta.get('duration_minutes', 60)}-minute practice software engineering interview ("{interview.title}"). {setting}

Score each area from 1 to 5: {area_names}.
Rules:
- Ground every score in the evidence below (test results, the diff, the candidate's notes, what they said). Quote or cite it.
- If there is no evidence for an area, say "not observed" instead of guessing.
{ai_rule}
Then list: missed cases, questionable assumptions, three concrete improvements, and one short follow-up exercise for the weakest observed skill.

=== Leadership Principles answers ===
{clip(behavioral, 40000)}

=== Rubric ===
{interview.rubric()}

=== Interviewer guide (answers and planted defects) ===
{interview.guide()}

=== Requirement change (revealed at minute {report['change_revealed_at_minutes']}) ===
{interview.change_request()}

=== Test results ===
Grading tests: {report['tests']['grading']['passed']}/{report['tests']['grading']['total']} passed. By area: {json.dumps(report['tests']['grading_by_area'])}
Missed cases:
{chr(10).join('- ' + m for m in report['missed_cases']) or '(none)'}
Candidate's own tests: {json.dumps(report['tests']['your_tests'])}; new tests: {report['tests']['your_new_tests']}; new tests that fail on the starter: {report['tests']['your_tests_that_catch_starter_bugs']}

=== Automatic heuristic scores (for reference; you may disagree) ===
{auto}

=== Clarification questions ===
{questions}

=== What the candidate said out loud (speech recognition, may contain errors) ===
{clip(spoken, 30000)}

=== Candidate's plan ===
{notes['plan'] or '(none)'}

=== Candidate's assumptions ===
{notes['assumptions'] or '(none)'}

=== Candidate's AI patch review ===
{notes['patch_review'] or '(none)'}

=== Candidate's final explanation ===
{notes['explanation'] or '(none)'}

=== Diff against the starter ===
{clip(diff_text, 60000) or '(no changes)'}

=== Coding-assistant transcript ===
{clip(notes['transcript'], 60000) or '(not supplied)'}
"""
