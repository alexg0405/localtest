"""Your résumé, for the résumé deep dive: kept on this computer in ~/interview-practice/.lab/resume.json.

The dashboard reads the file in the browser (Roomside's reader handles PDF and Word) and saves only its text here.
The interviewer gets that text with each question, through Claude Code on your own subscription. When Claude isn't
available, the scripted interviewer builds its questions from the roles and projects found in it.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

MAX_CHARS = 40_000

SECTION = re.compile(r"^(work |professional |relevant |research |leadership |personal |technical |software )?(experience|employment|projects?|research|leadership|activities|work history)( experience)?:?$", re.I)
OTHER_SECTION = re.compile(r"^(education|(technical )?skills|awards|honors|awards and honors|certifications?|(relevant )?coursework|interests|publications|summary|objective|languages|references|contact)( & \w+)?:?$", re.I)
LOCATION = re.compile(r"^([A-Z][a-z]+\.?( [A-Z][a-z]+)*, [A-Z]{2}|Remote|Hybrid|On-?site)\b[\s,]*$")
BULLET = re.compile(r"^\s*[-•▪◦●*·‣–◆■►]\s*")
MONTHS = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
DATES = re.compile(rf"\b({MONTHS}\s+)?(19|20)\d\d\b(\s*[-–—]\s*(({MONTHS}\s+)?(19|20)\d\d|present|current|now))?|\b(present|current)\b|\b{MONTHS}\s*[-–—]\s*{MONTHS}", re.I)
SEPARATORS = re.compile(r"\s*(?:\||·|•|—|–|\s-\s)\s*")
STOP_TERMS = {"I", "A", "An", "The", "And", "Or", "For", "With", "In", "On", "At", "To", "Of", "By", "From", "As", "My", "Our", "We",
              "Built", "Led", "Designed", "Developed", "Created", "Wrote", "Added", "Implemented", "Improved", "Reduced", "Increased", "Used",
              "Worked", "Managed", "Ran", "Set", "Helped", "Made", "Won", "Present", "Current", "Expected", "GPA", "Intern", "Engineer",
              "Software", "Engineering", "Developer", "Student", "Assistant", "University", "College", "School", "Inc", "LLC", "Corp",
              "Education", "Experience", "Projects", "Project", "Skills", "Technical", "Summary", "Awards", "Honors", "Relevant", "Coursework",
              "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec", "January", "February", "March",
              "April", "June", "July", "August", "September", "October", "November", "December", "B.S", "BS", "BA", "MS", "Minor", "Major",
              "Computer", "Science", "Bachelor", "Master", "Bachelors", "Masters", "State", "Best", "Use", "Real", "Team", "Lead", "Dean", "List"}


def _path(home: Path) -> Path:
    return home / ".lab" / "resume.json"


def normalize(text: str) -> str:
    """The whitespace cleanup Roomside does after reading a PDF or Word file."""
    text = re.sub(r"\r\n?", "\n", str(text))
    text = re.sub(r"[ \t\f\v]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def load(home: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and str(data.get("text", "")).strip() else None


def save(home: Path, name: str, text: str) -> Dict[str, Any]:
    text = normalize(text)[:MAX_CHARS]
    if len(text) < 80:
        raise ValueError("That résumé looks empty. Add the PDF or Word file, or paste its text.")
    data = {"name": (str(name).strip() or "Pasted résumé")[:200], "text": text, "updated": time.time()}
    path = _path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return data


def forget(home: Path) -> None:
    try:
        _path(home).unlink()
    except FileNotFoundError:
        pass


def summary(data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """What the dashboard shows without sending the whole text with every refresh."""
    if not data:
        return None
    return {"name": data["name"], "chars": len(data["text"]), "updated": data.get("updated"), "items": [label for _, label in items(data["text"])]}


def _headline(line: str, kind: str) -> str:
    """'Software Engineering Intern | Brightline Logistics | May 2026 – Aug 2026' -> 'your Software Engineering Intern role at
    Brightline Logistics'; 'StudySync — React, Node.js' -> 'StudySync'."""
    parts = [part.strip(" ,;:") for part in SEPARATORS.split(DATES.sub("", line)) if part.strip(" ,;:")]
    if len(parts) == 1 and kind == "role" and ", " in parts[0]:
        parts = [part.strip() for part in parts[0].split(", ") if part.strip()]  # "Software Intern, Acme"
    if not parts:
        return ""
    if kind == "role":
        role, place = parts[0], parts[1] if len(parts) > 1 else ""
        if place and not re.search(r"\b(intern|engineer|developer|assistant|researcher|lead|analyst|fellow|scientist|founder|tutor|president|officer|member|manager)\b", role, re.I) \
                and re.search(r"\b(intern|engineer|developer|assistant|researcher|lead|analyst|fellow|scientist|founder|tutor|president|officer|member|manager)\b", place, re.I):
            role, place = place, role  # "Company | Role" order
        return f"your {role} role at {place}" if place else f"your time as {role}"
    return parts[0]


def _section(line: str) -> Optional[str]:
    """'role' or 'project' for a heading such as EXPERIENCE or Projects & Activities, 'other' for Education or Skills, else None."""
    words = line.strip(" :").split()
    if not words or len(words) > 5 or line.strip().endswith("."):
        return None
    heading = " ".join(words)
    if OTHER_SECTION.match(heading):
        return "other"
    parts = [part.strip() for part in re.split(r"\s*(?:&|\band\b|/|,)\s*", heading, flags=re.I) if part.strip()]
    if parts and all(SECTION.match(part) for part in parts):
        return "project" if re.search(r"project", heading, re.I) else "role"
    return None


ROLE_WORDS = re.compile(r"\b(intern|engineer|developer|assistant|researcher|lead|analyst|fellow|scientist|founder|tutor|president|officer|member|manager|consultant|associate|contributor|ta)\b", re.I)
# A city is one word ("Boston, MA") unless it starts like "New York" or "Palo Alto", so "Northwind Labs Bedford, MA" keeps its name.
CITY_START = r"(?:New|San|Los|Las|Santa|Salt|Saint|St\.|Fort|El|Palo|Mountain|Redwood|Menlo|South|North|East|West|Grand|Long|Ann|Baton|Little|Cedar|Jersey|Kansas|College|Chapel|Sioux|Fort)"
LOCATION_TAIL = re.compile(rf"\s+((?:{CITY_START} )?[A-Z][a-z]+\.?, [A-Z]{{2}}|Remote|Hybrid)\s*$")


def items(text: str) -> List[Tuple[str, str]]:
    """The roles and projects listed on the résumé, best effort: [("role" or "project", how to say it)]. Handles one-line
    entries ("Intern | Acme | 2026") and the common two-line layout (company and city, then role and dates)."""
    found: List[Tuple[str, str]] = []
    section: Optional[str] = None
    company: Optional[str] = None

    def add(kind: str, label: str) -> None:
        label = label.strip(" ,;:–—-")
        if label and len(label) <= 120 and label.lower() not in {l.lower() for _, l in found}:
            found.append((kind, label))

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        heading = _section(line)
        if heading:
            section, company = (None if heading == "other" else heading), None
            continue
        if not section or BULLET.match(raw) or line.endswith(".") or line[0].islower() or len(line.split()) > 16:
            continue  # bullets, and the wrapped ends of bullets
        dated = bool(DATES.search(line))
        undated = DATES.sub("", line).strip(" ,;–—-")
        if dated and LOCATION.match(undated):
            continue  # "Seattle, WA  June 2025 – Aug 2025"
        separated = len(SEPARATORS.split(undated)) > 1
        if section == "project":
            if dated or separated:
                add("project", SEPARATORS.split(undated)[0])
            continue
        place = LOCATION_TAIL.search(undated)
        if place and not dated:
            company = undated[:place.start()].strip(" ,")  # "Acme  Boston, MA": the next line is the role
            continue
        if company:
            role = re.split(r"\s*(?:,|\||·|—|–|\s-\s)\s*", undated)[0]
            add("role", f"your {role} role at {company}" if ROLE_WORDS.search(role) else f"your time at {company}")
            company = None
        elif dated or separated:
            add("role", _headline(line, "role"))
    return found[:8]


def terms(text: str) -> List[str]:
    """Names and technologies on the résumé (StudySync, Redis, Node.js), for checking which ones the candidate explained."""
    seen: Dict[str, str] = {}
    lines = text.strip().splitlines()
    # Not the name at the top, and not the verb that starts each line ("Built", "Run").
    skip = set(lines[0].split()[:4]) if lines else set()
    skip |= {match.group(1) for match in re.finditer(r"^\s*[-•▪◦●*·‣–◆■►]\s*([A-Z][a-z]+)\b", text, re.M)}
    for word in re.findall(r"(?<![\w@./])[A-Z][A-Za-z0-9]*(?:[.+#][A-Za-z0-9+#]+)*\+*#?", text):
        word = word.rstrip(".")
        if len(word) < 2 or word in STOP_TERMS or word in skip or word.isupper() and len(word) > 5:
            continue
        seen.setdefault(word.lower(), word)
    return list(seen.values())[:80]


def plan(text: str) -> List[Dict[str, Any]]:
    """The scripted interviewer's questions, used when Claude isn't available: a walkthrough, two deep dives on things
    from the résumé, teamwork, then the candidate's questions."""
    found = items(text)
    projects = [label for kind, label in found if kind == "project"]
    roles = [label for kind, label in found if kind == "role"]
    first = (roles or projects or ["the project on your résumé you're proudest of"])[0]
    rest = [label for label in projects + roles[1:] if label != first]  # a project next, for something more technical
    second = rest[0] if rest else "a different project or role on your résumé"
    entry = lambda key, kind, question, followups: {"id": key, "kind": kind, "lp": None, "question": question, "followups": followups}
    return [
        entry("walkthrough", "walkthrough", "To start, walk me through your background in two or three minutes.",
              ["What are you looking for in your next role?"]),
        entry("deep-1", "depth", f"Let's go deep on {first}. What problem was it solving, and what did you personally build?",
              ["Walk me through how it worked, end to end. What were the main pieces?",
               "What's one technical decision you made there, and what alternatives did you consider?",
               "What was the hardest bug or obstacle, and how did you track it down?",
               "How did you know it worked? Any numbers?"]),
        entry("deep-2", "depth", f"Now tell me about {second}. What was your part, and what was the most technically interesting piece?",
              ["Why did you build it that way rather than another way?",
               "If you did it again today, what would you change?"]),
        entry("teamwork", "teamwork", "Tell me about a time you disagreed with a teammate about a technical decision. What happened?",
              ["What did you do yourself to resolve it?", "Looking back, what would you do differently?"]),
        entry("questions", "wrap", "That's all I had. What questions do you have for me?", []),
    ]
