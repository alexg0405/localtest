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
from .catalog import Interview, test_python
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
LABELS = dict(AREAS)
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
    questions = state.get("questions", [])
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
    text = "\n".join([notes["plan"], notes["transcript"], notes["explanation"]])
    if not notes["plan"].strip() and not notes["transcript"].strip():
        return None, ["No plan or transcript was recorded, so exploration could not be observed."]
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
    text = notes["explanation"]
    if not text.strip():
        return None, ["No final explanation was recorded."], []
    checks = [
        ("enough detail (80+ words)", len(text.split()) >= 80),
        ("tradeoffs or alternatives", re.search(r"\b(trade-?offs?|because|instead|alternatives?|downside|risk|cost|chose|choice)\b", text, re.I)),
        ("how you verified it", re.search(r"\b(tests?|verified|verify|checked|pytest|reproduc\w*)\b", text, re.I)),
        ("the requirement change", any(k.lower() in text.lower() for k in interview.meta.get("change_keywords", ["requirement change"]))),
        ("assumptions, limits, or next steps", re.search(r"\b(assum\w*|limitation\w*|production|future|next steps?|would also|didn'?t|not handled|left)\b", text, re.I)),
    ]
    present = [label for label, ok in checks if ok]
    missing = [label for label, ok in checks if not ok]
    evidence = [f"Final explanation: {len(text.split())} words."]
    if present:
        evidence.append("It covers " + "; ".join(present) + ".")
    if missing:
        evidence.append("It does not cover " + "; ".join(missing) + ".")
    return max(1, len(present)), evidence, missing


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
    if area == "communication":
        missing = context["communication_missing"]
        return ("In your final explanation, also cover " + "; ".join(missing) + ".") if missing else "Practice saying your explanation out loud in under two minutes."
    return ""


NOT_OBSERVED_HELP = {
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
    review_file = workspace / "patch_review" / "my_review.md"
    if review_file.exists():
        notes["patch_review"] = (notes["patch_review"] + "\n\n" + review_file.read_text(encoding="utf-8")).strip()

    runs = _run_all(interview, home)
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
    observed = sorted((area for area, _ in AREAS if scores[area][0] is not None), key=lambda a: (scores[a][0], [x for x, _ in AREAS].index(a)))
    improvements = [_improvement(area, context) for area in observed if scores[area][0] < 5][:3]
    for area, _ in AREAS:
        if len(improvements) >= 3:
            break
        if scores[area][0] is None and area in NOT_OBSERVED_HELP:
            improvements.append(NOT_OBSERVED_HELP[area])
    while len(improvements) < 3:
        improvements.append(["Try the follow-up exercise below under a 20-minute timer.", "Repeat this interview after a week without looking at your previous diff.", "Try a different interview from the lab to practice an unfamiliar domain."][len(improvements) % 3])
    weakest = observed[0]
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
    if revealed_at is None:
        assumptions.append("Submitted before the requirement change was revealed, so the change was not addressed.")
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
        "scores": [{"area": area, "label": label, "score": scores[area][0], "evidence": scores[area][1]} for area, label in AREAS],
        "missed_cases": [f"[{m['area']}] {m['description']}" for m in tests["missed"]],
        "questionable_assumptions": assumptions,
        "improvements": improvements,
        "follow_up": follow_up,
        "patch_review": {"found": patch["found"], "needed": patch["needed"], "answer": patch["expected"]},
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
    lines += ["", f"## Follow-up exercise ({follow['label']})", "", follow["exercise"], "", "## AI patch review", "", report["patch_review"]["answer"], "", "---", report["disclaimer"], ""]
    return "\n".join(lines)


def grading_prompt(interview: Interview, report: Dict[str, Any], diff_text: str, notes: Dict[str, str], state: Dict[str, Any]) -> str:
    """A self-contained prompt for grading this session in a separate Claude conversation (no API key needed)."""
    def clip(text: str, limit: int) -> str:
        return text if len(text) <= limit else text[:limit] + f"\n… [{len(text) - limit} more characters cut]"
    questions = "\n".join(f"- [{q['at'] / 60:.0f} min] Q: {q['question']}\n  A: {q['answer']}" for q in state.get("questions", [])) or "(none)"
    auto = "\n".join(f"- {s['label']}: {s['score'] if s['score'] is not None else 'not observed'}" for s in report["scores"])
    return f"""You are grading a 60-minute practice software engineering interview ("{interview.title}"). The candidate used an AI coding assistant (Claude Code), which is allowed and expected.

Score each area from 1 to 5: Problem understanding, Repository exploration, Quality of AI instructions, Verification of AI output, Correctness and edge cases, Testing, Code quality, Communication and tradeoffs.
Rules:
- Ground every score in the evidence below (test results, the diff, the candidate's notes, the transcript). Quote or cite it.
- If there is no evidence for an area, say "not observed" instead of guessing.
- Do not treat using less AI as better. Judge how well the candidate directed and checked the assistant.
Then list: missed cases, questionable assumptions, three concrete improvements, and one short follow-up exercise for the weakest observed skill.

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
