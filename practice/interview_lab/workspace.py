"""Candidate workspaces: created from an interview's starter, diffed against it, and reset to it.

A workspace only ever receives the starter folder plus generated assistant and
editor settings. Interviewer materials stay in the lab. Resetting never deletes
anything: changed and added files are moved to `.practice-backup/<time>/` first.
"""
from __future__ import annotations

import difflib
import filecmp
import json
import shutil
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from .catalog import LAB_ROOT, TEMPLATES_DIR, Interview, practice_home

MARKER = ".practice-workspace.json"
BACKUP_DIR = ".practice-backup"
SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", BACKUP_DIR, ".venv", "node_modules", ".mypy_cache", ".ruff_cache"}
SKIP_FILES = {MARKER, ".DS_Store"}
TEST_DIR = "tests"


class WorkspaceError(Exception):
    pass


def workspace_path(interview: Interview, home: Path) -> Path:
    return home / interview.id


def iter_files(root: Path) -> Dict[str, Path]:
    """Files under root keyed by POSIX relative path, without caches, git data, backups, or the marker."""
    found: Dict[str, Path] = {}
    if not root.exists():
        return found
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in SKIP_DIRS for part in relative.parts[:-1]) or (path.is_dir() and path.name in SKIP_DIRS):
            continue
        if path.is_file() and path.name not in SKIP_FILES and path.suffix != ".pyc":
            found[relative.as_posix()] = path
    return found


def _generated_files(interview: Interview, home: Path) -> Dict[str, str]:
    title = interview.title
    template = "CLAUDE.md" if interview.ai_allowed else "CLAUDE_no_ai.md"
    claude_md = (TEMPLATES_DIR / template).read_text(encoding="utf-8").format(title=title, lab_root=LAB_ROOT)
    lab_dirs = [LAB_ROOT, home / ".lab"]
    deny = [f"{tool}(/{directory}/**)" for directory in lab_dirs for tool in ("Read", "Edit")]
    claude_settings = {"permissions": {"deny": deny}}
    vscode = {
        "python.defaultInterpreterPath": str(home / ".venv" / "bin" / "python"),
        "python.testing.pytestEnabled": True,
        "python.testing.unittestEnabled": False,
        "python.testing.pytestArgs": [TEST_DIR],
        "files.exclude": {"**/__pycache__": True, BACKUP_DIR: True, MARKER: True},
    }
    return {
        "CLAUDE.md": claude_md,
        ".claude/settings.json": json.dumps(claude_settings, indent=2) + "\n",
        ".vscode/settings.json": json.dumps(vscode, indent=2) + "\n",
    }


def build_starter(interview: Interview, destination: Path, home: Path) -> None:
    """Writes the pristine candidate starter (starter folder + generated settings) into destination."""
    destination.mkdir(parents=True, exist_ok=True)
    for relative, source in iter_files(interview.starter).items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    for relative, text in _generated_files(interview, home).items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")


def read_marker(workspace: Path) -> Dict[str, Any]:
    try:
        return json.loads((workspace / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _git(workspace: Path, *args: str) -> None:
    try:
        subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass  # git is a convenience for the candidate, not a requirement


def create_workspace(interview: Interview, home: Path) -> Path:
    """Creates the workspace if it does not exist yet. An existing workspace is left as it is."""
    workspace = workspace_path(interview, home)
    if workspace.exists():
        marker = read_marker(workspace)
        if marker.get("interview") == interview.id:
            return workspace
        if any(workspace.iterdir()):
            raise WorkspaceError(f"{workspace} already exists and is not a practice workspace; move it or set PRACTICE_HOME")
    build_starter(interview, workspace, home)
    (workspace / MARKER).write_text(json.dumps({"interview": interview.id, "created": datetime.now().isoformat(timespec="seconds")}, indent=2) + "\n", encoding="utf-8")
    if not (workspace / ".git").exists():
        _git(workspace, "init", "-q")
        _git(workspace, "add", "-A")
        _git(workspace, "-c", "user.name=Interview Lab", "-c", "user.email=lab@localhost", "commit", "-q", "-m", "Starter code")
    return workspace


def _remove_empty_dirs(root: Path, keep: set) -> None:
    for directory in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        relative = directory.relative_to(root)
        if any(part in SKIP_DIRS for part in relative.parts) or relative.as_posix() in keep:
            continue
        try:
            directory.rmdir()  # only succeeds when empty
        except OSError:
            pass


def reset_workspace(interview: Interview, home: Path) -> Dict[str, Any]:
    """Restores the starter files. Files you changed or added are moved to a backup folder, never deleted."""
    workspace = workspace_path(interview, home)
    if read_marker(workspace).get("interview") != interview.id:
        raise WorkspaceError(f"{workspace} is not a workspace for {interview.id}; nothing was changed")
    backup = workspace / BACKUP_DIR / time.strftime("%Y%m%d-%H%M%S")
    restored: List[str] = []
    moved: List[str] = []
    with tempfile.TemporaryDirectory() as scratch:
        pristine = Path(scratch) / "starter"
        build_starter(interview, pristine, home)
        starter_files = iter_files(pristine)
        for relative, path in iter_files(workspace).items():
            if relative not in starter_files:
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(target))
                moved.append(relative)
            elif not filecmp.cmp(path, starter_files[relative], shallow=False):
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                shutil.copy2(starter_files[relative], path)
                restored.append(relative)
        for relative, source in starter_files.items():
            target = workspace / relative
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                restored.append(relative)
        keep = {Path(r).parent.as_posix() for r in starter_files}
    _remove_empty_dirs(workspace, keep)
    return {"workspace": str(workspace), "restored": sorted(restored), "moved_to_backup": sorted(moved), "backup": str(backup) if (restored or moved) else None}


def _read_text(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines(keepends=True)
    except (UnicodeDecodeError, OSError):
        return []


def diff_against_starter(interview: Interview, home: Path) -> Dict[str, Any]:
    """Unified diffs of the workspace against a pristine starter, with simple line counts."""
    workspace = workspace_path(interview, home)
    files: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as scratch:
        pristine = Path(scratch) / "starter"
        build_starter(interview, pristine, home)
        before, after = iter_files(pristine), iter_files(workspace)
        for relative in sorted(set(before) | set(after)):
            old = _read_text(before[relative]) if relative in before else []
            new = _read_text(after[relative]) if relative in after else []
            if relative in before and relative in after and old == new:
                continue
            status = "added" if relative not in before else "deleted" if relative not in after else "modified"
            lines = list(difflib.unified_diff(old, new, f"a/{relative}", f"b/{relative}", n=2))
            added = [line[1:] for line in lines if line.startswith("+") and not line.startswith("+++")]
            removed = [line[1:] for line in lines if line.startswith("-") and not line.startswith("---")]
            files.append({"path": relative, "status": status, "diff": "".join(lines), "added_lines": added, "removed_lines": removed})
    return {"files": files, "text": "".join(f["diff"] for f in files)}


def ensure_home(home: Path = None) -> Path:
    home = home or practice_home()
    home.mkdir(parents=True, exist_ok=True)
    return home
