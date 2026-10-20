"""The local dashboard: a small JSON API plus static files, served on 127.0.0.1 only."""
from __future__ import annotations

import json
import mimetypes
import os
import subprocess
import socketserver
import tempfile
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from . import api, coach_ai, grading, interviewer, resume
from .catalog import all_interviews, get_interview, shell_commands, test_python
from .session import SessionError, Sessions
from .testing import run_pytest, summary
from .workspace import WorkspaceError, read_marker, reset_workspace, workspace_path

STATIC = Path(__file__).resolve().parent / "static"
STATIC_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
                ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".md": "text/markdown"}
GRADE_LOCK = threading.Lock()


class Lab:
    """Everything the handlers need, so tests can build one with a temporary home and a fake clock."""

    def __init__(self, home: Path, sessions: Optional[Sessions] = None, api_config: Optional[api.ApiConfig] = None):
        self.home = home
        self.sessions = sessions or Sessions(home)
        self.api = api_config or api.ApiConfig()


def _handler(lab: Lab, port_holder: Dict[str, int]):
    class Handler(BaseHTTPRequestHandler):
        server_version = "InterviewLab"

        def log_message(self, format: str, *args: Any) -> None:  # keep the terminal quiet
            pass

        # Helpers

        def _allowed_host(self) -> bool:
            port = port_holder["port"]
            return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload: Any) -> None:
            self._send(status, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, status: int, message: str) -> None:
            self._json(status, {"error": message})

        def _interview(self, interview_id: Optional[str]):
            return get_interview(interview_id or "")

        # Routing

        def do_GET(self) -> None:
            if not self._allowed_host():
                return self._error(HTTPStatus.FORBIDDEN, "Open the dashboard at http://127.0.0.1.")
            url = urlparse(self.path)
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            try:
                if url.path in ("/", "/index.html"):
                    return self._static("index.html")
                if url.path.startswith("/static/"):
                    return self._static(url.path[len("/static/"):])
                if url.path == "/api/interviews":
                    return self._json(200, [self._summary(i) for i in all_interviews()])
                if url.path == "/api/state":
                    return self._json(200, self._state(self._interview(query.get("interview"))))
                if url.path == "/api/report":
                    report, _ = grading.latest_report(self._interview(query.get("interview")), lab.home)
                    return self._json(200, {"report": report})
                if url.path == "/api/file":
                    interview = self._interview(query.get("interview"))
                    path = self._editor_file(interview, query.get("path", ""))
                    return self._json(200, {"path": query.get("path"), "content": path.read_text(encoding="utf-8"), "mtime": path.stat().st_mtime})
                if url.path == "/api/my-resume":
                    saved = resume.load(lab.home)
                    return self._json(200, {"resume": {**resume.summary(saved), "text": saved["text"]} if saved else None})
                if url.path == "/api/packet":
                    return self._json(200, {"text": self._packet(self._interview(query.get("interview")), query.get("kind", ""))})
                return self._error(HTTPStatus.NOT_FOUND, "Not found.")
            except KeyError as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error.args[0]))
            except (SessionError, WorkspaceError, ValueError) as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error))

        def _coach(self, interview, body: Dict[str, Any]) -> None:
            """Streams a conversational coach reply as NDJSON: {"text"} chunks, then {"done", "entry"} (or {"fallback"})."""
            sessions = lab.sessions
            state = sessions.load(interview.id)
            if not state:
                raise SessionError("No session yet. Start the interview first.")
            conversation = interview.meta.get("format") == "resume"
            if interview.meta.get("format") != "problem" and not conversation:
                raise SessionError("The conversational interviewer is available in the practice problems and the résumé deep dive.")
            trigger = str(body.get("trigger", "message"))
            trigger = trigger if trigger in coach_ai.TRIGGERS else "message"
            message = str(body.get("message", ""))[:6000]
            hint = sessions.take_hint(interview) if trigger == "hint" and not conversation else None
            status = sessions.status(interview)
            if conversation:
                saved = resume.load(lab.home)
                prompt = coach_ai.build_resume_prompt(interview, sessions.load(interview.id), saved["text"] if saved else "(no résumé was added)", status["elapsed"], trigger, message)
            else:
                phase = next((p["name"] for p in status["phases"][status["phase"]:status["phase"] + 1]), "overtime")
                prompt = coach_ai.build_prompt(interview, sessions.load(interview.id), workspace_path(interview, lab.home), status["elapsed"], phase, trigger, message, hint)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            def send(event: Dict[str, Any]) -> None:
                self.wfile.write((json.dumps(event) + "\n").encode("utf-8"))
                self.wfile.flush()

            text = ""
            try:
                for chunk in coach_ai.stream(prompt):
                    text += chunk
                    send({"text": chunk})
            except coach_ai.CoachError as error:
                if conversation:
                    # The scripted interviewer takes over: the answer counts, then its next planned question.
                    if trigger == "message" and message.strip():
                        if interviewer.is_question(message):
                            entry = sessions.ask(interview, message, bool(body.get("voice")))
                        else:
                            sessions.record_answer(interview, message)
                            entry = sessions.behavioral_next(interview)
                    else:
                        entry = sessions.behavioral_next(interview)
                    send({"fallback": str(error), "entry": entry})
                    return
                # The scripted coach answers instead, without counting a second hint.
                if trigger == "hint":
                    coach = state.get("mode") == "coach"
                    if hint and hint.get("repeat"):
                        text = (f"Let's stay with the last hint for a moment: {hint['text']} Which part of it is unclear, or what would you try first?" if coach
                                else "I'd like to see you try the last hint first. What are you thinking?")
                    elif hint:
                        text = (f"Hint {hint['level']} of {hint['total']}: " if coach else "Sure, here's a nudge. ") + hint["text"]
                    else:
                        text = "That's all my hints. If you want, open the menu and choose Show the approach." if coach else "That's as much as I can give you. Try to take it from there."
                    entry = sessions.record_coach(interview, "hint", "", text)
                elif trigger == "message" and message.strip():
                    entry = sessions.ask(interview, message, bool(body.get("voice")))
                elif trigger == "nudge":
                    entry = sessions.coach_nudge(interview)
                elif trigger == "tests":
                    entry = sessions.coach_on_tests(interview, {"cases": [{"outcome": "failed", "base": c["name"].split("[")[0].split("::")[-1], "message": c["message"]} for c in (sessions.load(interview.id).get("last_test_run") or {}).get("failing", [])], "total": 1})
                else:
                    entry = None
                send({"fallback": str(error), "entry": entry})
                return
            except (BrokenPipeError, ConnectionResetError):
                return
            reply = text.strip() or "Tell me what you're thinking, and we'll take it from there."
            entry = sessions.record_coach(interview, trigger, message, reply, bool(body.get("voice")))
            try:
                send({"done": True, "entry": entry})
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _debrief(self, interview) -> None:
            """Streams the interviewer's written notes on the latest submission (NDJSON {"text"} chunks, then {"done"}), and saves them with it."""
            report, folder = grading.latest_report(interview, lab.home)
            state = lab.sessions.load(interview.id)
            if not report or not state or interview.meta.get("format") != "resume":
                raise SessionError("Submit the résumé interview first.")
            saved = resume.load(lab.home)
            prompt = coach_ai.build_debrief_prompt(interview, state, saved["text"] if saved else "(no résumé)", report)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            send = lambda event: (self.wfile.write((json.dumps(event) + "\n").encode("utf-8")), self.wfile.flush())
            text = ""
            try:
                for chunk in coach_ai.stream(prompt, timeout=180, system=coach_ai.DEBRIEF_SYSTEM):
                    text += chunk
                    send({"text": chunk})
            except coach_ai.CoachError as error:
                try:
                    send({"error": str(error)})
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            except (BrokenPipeError, ConnectionResetError):
                return
            if text.strip():
                report["interviewer_notes"] = text.strip()
                (folder / "interviewer_notes.md").write_text(text.strip() + "\n", encoding="utf-8")
                (folder / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            try:
                send({"done": True})
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self) -> None:
            if not self._allowed_host():
                return self._error(HTTPStatus.FORBIDDEN, "Open the dashboard at http://127.0.0.1.")
            origin = self.headers.get("Origin")
            port = port_holder["port"]
            if origin and origin not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
                return self._error(HTTPStatus.FORBIDDEN, "Cross-origin requests are not allowed.")
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Send JSON.")
            try:
                length = min(int(self.headers.get("Content-Length", "0")), 2_000_000)
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("Send a JSON object.")
                interview = self._interview(body.get("interview"))
                action = urlparse(self.path).path
                sessions = lab.sessions
                if action == "/api/start":
                    sessions.start(interview, reset=bool(body.get("reset")), mode=str(body.get("mode", "real")))
                elif action == "/api/mode":
                    sessions.set_mode(interview, str(body.get("mode", "real")))
                elif action == "/api/hint":
                    return self._json(200, {"entry": sessions.hint(interview)})
                elif action == "/api/approach":
                    return self._json(200, {"entry": sessions.reveal_approach(interview)})
                elif action == "/api/coach":
                    return self._coach(interview, body)
                elif action == "/api/nudge":
                    return self._json(200, {"entry": sessions.coach_nudge(interview)})
                elif action == "/api/pause":
                    sessions.pause(interview)
                elif action == "/api/resume":
                    sessions.resume(interview)
                elif action == "/api/reveal":
                    sessions.reveal_now(interview)
                elif action == "/api/reset":
                    return self._json(200, {"reset": reset_workspace(interview, lab.home), **self._state(interview)})
                elif action == "/api/note":
                    sessions.set_note(interview, str(body.get("field", "")), str(body.get("text", "")))
                    return self._json(200, {"saved": True})
                elif action == "/api/ask":
                    return self._json(200, {"entry": self._ask(interview, str(body.get("question", "")), bool(body.get("use_api")), bool(body.get("voice")))})
                elif action == "/api/speech":
                    sessions.record_speech(interview, str(body.get("text", "")))
                    return self._json(200, {"saved": True})
                elif action == "/api/cue":
                    return self._json(200, {"entry": sessions.cue(interview, str(body.get("cue", "")))})
                elif action == "/api/file":
                    path = self._editor_file(interview, str(body.get("path", "")))
                    base = body.get("mtime")
                    if base is not None and abs(path.stat().st_mtime - float(base)) > 1e-6 and not body.get("force"):
                        return self._json(409, {"error": "The file changed on disk (in your other editor). Reload it, or save again to overwrite.", "content": path.read_text(encoding="utf-8"), "mtime": path.stat().st_mtime})
                    content = str(body.get("content", ""))
                    if len(content) > 500_000:
                        raise ValueError("That file is too large.")
                    path.write_text(content, encoding="utf-8")
                    return self._json(200, {"saved": True, "mtime": path.stat().st_mtime})
                elif action == "/api/run":
                    return self._json(200, self._run_snippet(interview, str(body.get("code", ""))))
                elif action == "/api/answer":
                    sessions.record_answer(interview, str(body.get("text", "")))
                    return self._json(200, {"saved": True})
                elif action == "/api/behavioral":
                    return self._json(200, {"entry": sessions.behavioral_next(interview)})
                elif action == "/api/followup":
                    return self._json(200, {"entry": sessions.follow_up(interview, str(body.get("phase", "")))})
                elif action == "/api/test":
                    return self._json(200, self._run_visible(interview))
                elif action == "/api/submit":
                    with GRADE_LOCK:
                        sessions.mark_submitted(interview)
                        report = grading.grade(interview, lab.home, sessions)
                    return self._json(200, {"report": report})
                elif action == "/api/my-resume":
                    if body.get("forget"):
                        resume.forget(lab.home)
                        return self._json(200, {"resume": None})
                    saved = resume.save(lab.home, str(body.get("name", "")), str(body.get("text", "")))
                    return self._json(200, {"resume": {**resume.summary(saved), "text": saved["text"]}})
                elif action == "/api/debrief":
                    return self._debrief(interview)
                elif action == "/api/feedback":
                    return self._json(200, self._feedback(interview))
                else:
                    return self._error(HTTPStatus.NOT_FOUND, "Not found.")
                return self._json(200, self._state(interview))
            except KeyError as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error.args[0]))
            except (SessionError, WorkspaceError, ValueError) as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error))
            except api.ApiError as error:
                return self._json(HTTPStatus.OK, {"api_error": {"kind": error.kind, "message": str(error)}})

        # Pieces

        def _static(self, name: str) -> None:
            path = (STATIC / name).resolve()
            if STATIC.resolve() not in path.parents or not path.is_file():
                return self._error(HTTPStatus.NOT_FOUND, "Not found.")
            # Not the system's table: on Windows it comes from the registry, which can call .js plain text (and nosniff then blocks it).
            content_type = STATIC_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type.endswith("javascript"):
                content_type += "; charset=utf-8"
            self._send(200, path.read_bytes(), content_type)

        def _summary(self, interview) -> Dict[str, Any]:
            state = lab.sessions.load(interview.id)
            report, _ = grading.latest_report(interview, lab.home)
            grading_tests = (report or {}).get("tests", {}).get("grading") or {}
            best = round(100 * grading_tests["passed"] / grading_tests["total"]) if grading_tests.get("total") else None
            return {**interview.public(), "status": state["status"] if state else "not started",
                    "mode": (state or {}).get("mode", "real"), "last_score": best, "last_mode": (report or {}).get("mode"),
                    "workspace_exists": bool(read_marker(workspace_path(interview, lab.home)))}

        def _state(self, interview) -> Dict[str, Any]:
            status = lab.sessions.status(interview)
            usage = status.get("state", {}).get("api_usage") if status.get("started") else None
            report, _ = grading.latest_report(interview, lab.home)
            workspace = workspace_path(interview, lab.home)
            python = test_python(lab.home)
            coach = None
            if interview.meta.get("format") in ("problem", "resume"):
                coach = coach_ai.status()
                if coach["available"] and status.get("started") and not getattr(lab, "warmed", {}).get(interview.id):
                    lab.warmed = {**getattr(lab, "warmed", {}), interview.id: True}
                    coach_ai.warm()
            return {
                "coach_ai": coach,
                "resume": resume.summary(resume.load(lab.home)) if interview.meta.get("format") == "resume" else None,
                "interview": interview.public(),
                "task": interview.task(),
                "session": status,
                "api": lab.api.public(usage),
                "has_report": report is not None,
                "workspace": str(workspace),
                "workspace_exists": bool(read_marker(workspace)),
                "files": {name: (workspace / name).stat().st_mtime for name in interview.meta.get("editor_files", []) if (workspace / name).is_file()},
                "commands": shell_commands(workspace, python, lab.home / ".venv"),
            }

        def _ask(self, interview, question: str, use_api: bool, voice: bool = False) -> Dict[str, Any]:
            if not (use_api and lab.api.enabled):
                return lab.sessions.ask(interview, question, voice)
            state = lab.sessions.load(interview.id)
            if not state:
                raise SessionError("No session yet. Start the interview first.")
            revealed = state.get("change_revealed_at") is not None
            key = "\n".join(f"- {e['topic']}: {e.get('answer_after_change') if revealed and e.get('answer_after_change') else e['answer']}" for e in interview.clarifications())
            prompt = f"Answer key:\n{key}\n\nInterviewer guide:\n{interview.guide()}\n\nThe requirement change {'has' if revealed else 'has NOT'} been revealed.\n\nCandidate's question: {question.strip()[:2000]}"
            try:
                result = api.complete(lab.api, api.INTERVIEWER_SYSTEM, prompt, state.get("api_usage", {}), lab.home)
            except api.ApiError as error:
                entry = lab.sessions.ask(interview, question, voice)  # graceful fallback to the offline interviewer
                entry["api_error"] = {"kind": error.kind, "message": str(error)}
                return entry
            lab.sessions.add_api_usage(interview, result["usage"])
            entry = {"question": question.strip()[:2000], "answer": result["text"], "topic": None, "matched": True, "source": "api", "usage": result["usage"], "voice": voice}
            local = interviewer.answer(interview, question, revealed)  # still credit the topic for scoring
            entry["topic"] = local["topic"]
            lab.sessions.record_question(interview, entry)
            return entry

        def _editor_file(self, interview, relative: str) -> Path:
            """Only the files the interview lets the browser editor open, inside its workspace."""
            if relative not in interview.meta.get("editor_files", []):
                raise ValueError("That file can't be opened in the browser editor.")
            path = (workspace_path(interview, lab.home) / relative).resolve()
            if not read_marker(workspace_path(interview, lab.home)) or not path.is_file():
                raise WorkspaceError("Start the interview first, so the workspace exists.")
            return path

        def _run_snippet(self, interview, code: str) -> Dict[str, Any]:
            """Runs a few lines of Python against the workspace (custom input), with a time limit."""
            workspace = workspace_path(interview, lab.home)
            if not read_marker(workspace):
                raise WorkspaceError("Start the interview first, so the workspace exists.")
            if not code.strip():
                raise ValueError("Write some code to run, for example a print() call.")
            with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as handle:
                handle.write(code[:50_000])
                script = handle.name
            env = {**os.environ, "PYTHONPATH": str(workspace), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
            try:
                done = subprocess.run([test_python(lab.home), script], cwd=workspace, capture_output=True, encoding="utf-8", errors="replace", timeout=10, env=env)
                result = {"ok": done.returncode == 0, "stdout": done.stdout[-20_000:], "stderr": done.stderr[-20_000:], "timed_out": False}
            except subprocess.TimeoutExpired as error:
                result = {"ok": False, "stdout": (error.stdout or b"").decode("utf-8", "replace")[-20_000:] if isinstance(error.stdout, bytes) else (error.stdout or ""), "stderr": "Stopped after 10 seconds (an infinite loop?).", "timed_out": True}
            finally:
                os.unlink(script)
            if lab.sessions.load(interview.id):
                lab.sessions.record_code_run(interview, result["ok"])
            return result

        def _run_visible(self, interview) -> Dict[str, Any]:
            workspace = workspace_path(interview, lab.home)
            if not read_marker(workspace):
                raise WorkspaceError("Start the interview first, so the workspace exists.")
            if not interview.meta.get("run_tests_allowed", True):
                raise ValueError("This round simulates an editor that can't run code: dry-run your solution by hand. Grading runs it after you submit.")
            result = run_pytest(test_python(lab.home), workspace, ["tests"])
            coach = None
            state = lab.sessions.load(interview.id)
            if state:
                lab.sessions.record_test_run(interview, summary(result))
                lab.sessions.record_test_details(interview, result)
                # With Claude available, the page asks the conversational coach instead of the scripted reaction.
                if not (interview.meta.get("format") == "problem" and coach_ai.status()["available"]):
                    coach = lab.sessions.coach_on_tests(interview, result)
            return {"coach": coach, "result": {**summary(result), "output": result["output"], "cases": [{"name": c["id"].split("::", 1)[-1] if not c["collection_error"] else c["name"], "outcome": c["outcome"], "message": c["message"]} for c in result["cases"]]}}

        def _packet(self, interview, kind: str) -> str:
            if kind == "interviewer":
                return interviewer.interviewer_packet(interview)
            if kind == "grading":
                _, folder = grading.latest_report(interview, lab.home)
                if folder is None:
                    raise ValueError("Submit the session first; the grading prompt is built from your submission.")
                return (folder / "grading_prompt.md").read_text(encoding="utf-8")
            raise ValueError("kind must be 'interviewer' or 'grading'.")

        def _feedback(self, interview) -> Dict[str, Any]:
            _, folder = grading.latest_report(interview, lab.home)
            if folder is None:
                raise ValueError("Submit the session first.")
            state = lab.sessions.load(interview.id) or {}
            result = api.complete(lab.api, api.FEEDBACK_SYSTEM, (folder / "grading_prompt.md").read_text(encoding="utf-8"), state.get("api_usage", {}), lab.home)
            lab.sessions.add_api_usage(interview, result["usage"])
            (folder / "api_feedback.md").write_text(result["text"] + "\n", encoding="utf-8")
            return {"feedback": result["text"], "usage": result["usage"], "model": result["model"]}

    return Handler


class LabServer(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets a second server take a port that's already in use, so a second lab would split the requests.
    allow_reuse_address = os.name != "nt"

    def server_bind(self) -> None:
        # Skips HTTPServer's reverse DNS lookup of 127.0.0.1, which can take seconds on some Windows networks.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def make_server(lab: Lab, port: int = 8765) -> ThreadingHTTPServer:
    holder = {"port": port}
    server = LabServer(("127.0.0.1", port), _handler(lab, holder))
    holder["port"] = server.server_address[1]
    return server


def serve(lab: Lab, port: int = 8765, open_browser: bool = True) -> None:
    server = make_server(lab, port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Interview Lab dashboard: {url}")
    print(f"Workspaces: {lab.home}")
    print(lab.api.public()["message"])
    print("Press Ctrl+C to stop.")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
