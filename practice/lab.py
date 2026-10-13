#!/usr/bin/env python3
"""Interview Lab command line.

    python3 practice/lab.py setup              create the test virtualenv (pytest) in ~/interview-practice/.venv
    python3 practice/lab.py serve              open the dashboard at http://127.0.0.1:8765
    python3 practice/lab.py list               list the interviews
    python3 practice/lab.py start ID [--reset] create the workspace and start the timer without the dashboard
    python3 practice/lab.py reset ID           restore a workspace to the starter (changed files are backed up)
    python3 practice/lab.py submit ID          grade the current session and print the report
    python3 practice/lab.py verify             check that every interview, the change, reset, and grading work

Set PRACTICE_HOME to keep workspaces somewhere other than ~/interview-practice.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import venv
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from interview_lab import api, grading  # noqa: E402
from interview_lab.catalog import LAB_ROOT, all_interviews, get_interview, practice_home, test_python  # noqa: E402
from interview_lab.session import Sessions  # noqa: E402
from interview_lab.workspace import ensure_home, reset_workspace  # noqa: E402


def setup(home: Path) -> int:
    target = home / ".venv"
    if not (target / "bin" / "python").exists():
        print(f"Creating a virtualenv in {target} …")
        venv.EnvBuilder(with_pip=True).create(target)
    python = target / "bin" / "python"
    print("Installing pytest …")
    result = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", str(LAB_ROOT / "requirements.txt")])
    if result.returncode:
        print("pip failed. Check your network connection, then run setup again.")
        return result.returncode
    version = subprocess.run([str(python), "-m", "pytest", "--version"], capture_output=True, text=True).stdout.strip()
    print(f"Ready: {version} at {python}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 practice/lab.py", description="Local practice for AI-assisted engineering interviews.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup", help="create the test virtualenv with pytest")
    serve = sub.add_parser("serve", help="run the dashboard")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--no-open", action="store_true", help="do not open a browser")
    sub.add_parser("list", help="list interviews")
    start = sub.add_parser("start", help="create the workspace and start the timer")
    start.add_argument("interview")
    start.add_argument("--reset", action="store_true", help="reset the workspace to the starter first")
    reset = sub.add_parser("reset", help="restore the starter files")
    reset.add_argument("interview")
    submit = sub.add_parser("submit", help="grade the current session")
    submit.add_argument("interview")
    sub.add_parser("verify", help="self-check the lab")
    args = parser.parse_args(argv)

    home = ensure_home(practice_home())
    if args.command == "setup":
        return setup(home)
    if args.command == "verify":
        from interview_lab.verify import run
        return run()
    if args.command == "list":
        for interview in all_interviews():
            print(f"{interview.id:18} {interview.title}")
        return 0
    if args.command == "serve":
        from interview_lab.server import Lab, serve as run_server
        if "pytest" not in subprocess.run([test_python(home), "-m", "pytest", "--version"], capture_output=True, text=True).stdout:
            print("Note: pytest was not found for the test Python. Run: python3 practice/lab.py setup")
        run_server(Lab(home, api_config=api.ApiConfig()), port=args.port, open_browser=not args.no_open)
        return 0

    interview = get_interview(args.interview)
    sessions = Sessions(home)
    if args.command == "start":
        sessions.start(interview, reset=args.reset)
        status = sessions.status(interview)
        print(f"Started {interview.title}. Workspace: {status['workspace']}")
        print(f"Open it in your editor and start Claude Code there:  cd \"{status['workspace']}\" && claude")
        return 0
    if args.command == "reset":
        report = reset_workspace(interview, home)
        print(f"Restored {len(report['restored'])} file(s); moved {len(report['moved_to_backup'])} file(s) to {report['backup'] or 'no backup needed'}.")
        return 0
    if args.command == "submit":
        sessions.mark_submitted(interview)
        report = grading.grade(interview, home, sessions)
        print(grading.render_markdown(report))
        print(f"Saved to {report['saved_to']}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
