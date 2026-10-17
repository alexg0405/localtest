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

from . import interviewer
from .catalog import Interview, leadership_bank, test_python
from .session import CHANGE_FILE, Sessions
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
LABELS = {**dict(AREAS), **dict(AMAZON_AREAS), **dict(BEHAVIORAL_AREAS), **dict(PROBLEM_AREAS)}


def areas_for(interview: Interview):
    return {"amazon-final": AMAZON_AREAS, "amazon-behavioral": BEHAVIORAL_AREAS, "problem": PROBLEM_AREAS}.get(interview.meta.get("format"), AREAS)


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
NOT_SOURCE_FILES = {CHANGE_FILE, "CLAUDE.md", "README.md", ".gitignore", "pytest.ini"}
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
    ("result", "said how it turned out", r"\b(as a result|result(ed|s)?|outcome|in the end|eventually|ended up|shipped|launched|delivered|reduced|increased|improved|saved|cut|grew|won|finished|on time|so we)\b"),
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
    stories = [_story(a, bank) for a in state.get("behavioral", {}).get("answers", []) if a.get("parts")]
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
    asked = len(Sessions.behavioral_questions(interview, state))
    if len(stories) < asked:
        evidence.append(f"Answered {len(stories)} of {asked} Leadership Principles questions.")
    average = sum(story["score"] for story in stories) / len(stories)
    return _clamp(average - (0.5 if len(stories) < asked else 0)), evidence, sorted(missing_all)


def lp_breakdown(interview, state) -> List[Dict[str, Any]]:
    return [{"lp": story["lp"], "question": story["question"], "score": story["score"], "missing": story["missing"]} for story in _stories(interview, state)]


def _score_problem_solving(interview, notes, runs):
    text = "\n".join([notes["plan"], notes["explanation"], notes["spoken"]]).lower()
    perf = [c for c in runs["hidden"]["cases"] if interview.cases().get(c["base"], {}).get("area") == "performance"]
    if not text.strip() and not perf:
        return None, ["No approach or complexity was written or said."], []
    checks = [
        ("stated the time complexity", re.search(r"\bo\(|big[- ]o|\blinear\b|\blog(arithmic)?\b|n log|quadratic|constant time", text)),
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
    coding = [p for p in phases if p.get("kind") == "coding"]
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
        ("stated the complexity out loud", re.search(r"\bo\(|big[- ]o|\blinear\b|\blog(arithmic)?\b|n log|quadratic|constant (time|space)", narrated.lower()) is not None),
    ]
    present = [label for label, ok in checks if ok]
    missing = [label for label, ok in checks if not ok]
    evidence = [f"You said {len(narrated.split())} words while coding and wrote {len(notes['explanation'].split())} in your walkthrough."]
    if present:
        evidence.append("You " + "; ".join(present) + ".")
    if missing:
        evidence.append("Missing: " + "; ".join(missing) + ".")
    return _clamp(1 + len(present)), evidence, missing


def _improvement(area: str, context: Dict[str, Any]) -> str:
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
    if area == "problem_solving":
        missing = context.get("solving_missing", [])
        return ("Before you code, say your approach and its complexity, and how it beats brute force. You never: " + "; ".join(missing[:3]) + ".") if missing else "Practice stating time and space complexity in one sentence before writing any code."
    if area == "communication" and context["interview"].meta.get("format") == "amazon-final":
        missing = context["communication_missing"]
        return ("Narrate while you code: " + "; ".join(missing[:3]) + ".") if missing else "Prepare two or three questions about the team to ask at the end."
    if area == "communication":
        missing = context["communication_missing"]
        return ("In your final explanation, also cover " + "; ".join(missing) + ".") if missing else "Practice saying your explanation out loud in under two minutes."
    return ""


NOT_OBSERVED_HELP = {
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

    behavioral_only = interview.meta.get("format") == "amazon-behavioral"
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
    if amazon or problem:
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
        scores.update({"leadership": (lp_score, lp_evidence), "problem_solving": (ps_score, ps_evidence), "communication": (cm_score, cm_evidence), "testing": (te_score, te_evidence)})
    if behavioral_only:
        scores.update(_behavioral_scores(interview, state, notes))
        context["leadership_missing"] = _score_leadership(interview, state)[2]
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
        assumptions.append("Submitted before the interviewer's follow-up was revealed, so it was not addressed." if amazon else "Submitted before the requirement change was revealed, so the change was not addressed.")
    elif tests["by_area"].get("change", {}).get("passed", 0) == 0 and tests["by_area"].get("change"):
        assumptions.append("The requirement change was revealed but none of its cases pass.")

    elapsed = sessions.elapsed(state)
    report = {
        "interview": interview.id,
        "title": interview.title,
        "submitted": datetime.now().isoformat(timespec="seconds"),
        "elapsed_minutes": round(elapsed / 60, 1),
        "change_revealed_at_minutes": None if revealed_at is None else round(revealed_at / 60, 1),
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
        "format_note": ("No AI in this round: Amazon tells candidates not to use GenAI tools during interviews unless explicitly permitted, so the AI areas are not scored." if amazon or behavioral_only
                        else (f"Coach mode: you used {len(state.get('hints', []))} hint(s){' and opened the reference approach' if state.get('approach_revealed') else ''}. Try it again in real mode once it feels easy." if problem and state.get("mode") == "coach"
                              else (f"Real mode: {len(state.get('hints', []))} hint(s) used." if problem else None))),
        "mode": state.get("mode", "real") if problem else None,
        "hints_used": len(state.get("hints", [])) if problem else None,
        "approach": interview.approach() if problem else None,
        "lp_breakdown": lp_breakdown(interview, state) if amazon or behavioral_only else None,
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
    setting = ("This is a simulated Amazon SDE intern final-round interview with no AI assistant (Amazon tells candidates not to use GenAI during interviews). It has Leadership Principles questions with follow-ups, then a coding problem in an editor that can run tests."
               if amazon else (f"This is a single-problem practice round with no AI assistant, in {state.get('mode', 'real')} mode. The candidate used {len(hints)} hint(s){' and opened the reference approach' if state.get('approach_revealed') else ''}." if problem
                               else "The candidate used an AI coding assistant (Claude Code), which is allowed and expected."))
    ai_rule = "- Judge Leadership Principles answers on STAR structure, personal ownership, measurable results, and how well follow-ups were handled." if amazon else "- Do not treat using less AI as better. Judge how well the candidate directed and checked the assistant."
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
