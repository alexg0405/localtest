"""The local dashboard: a small JSON API plus static files, served on 127.0.0.1 only."""
from __future__ import annotations

import json
import mimetypes
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from . import api, grading, interviewer
from .catalog import all_interviews, get_interview, test_python
from .session import SessionError, Sessions
from .testing import run_pytest, summary
from .workspace import WorkspaceError, read_marker, reset_workspace, workspace_path

STATIC = Path(__file__).resolve().parent / "static"
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
                if url.path == "/api/packet":
                    return self._json(200, {"text": self._packet(self._interview(query.get("interview")), query.get("kind", ""))})
                return self._error(HTTPStatus.NOT_FOUND, "Not found.")
            except KeyError as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error.args[0]))
            except (SessionError, WorkspaceError, ValueError) as error:
                return self._error(HTTPStatus.BAD_REQUEST, str(error))

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
                    sessions.start(interview, reset=bool(body.get("reset")))
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
                elif action == "/api/followup":
                    return self._json(200, {"entry": sessions.follow_up(interview, str(body.get("phase", "")))})
                elif action == "/api/test":
                    return self._json(200, self._run_visible(interview))
                elif action == "/api/submit":
                    with GRADE_LOCK:
                        sessions.mark_submitted(interview)
                        report = grading.grade(interview, lab.home, sessions)
                    return self._json(200, {"report": report})
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
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type.endswith("javascript"):
                content_type += "; charset=utf-8"
            self._send(200, path.read_bytes(), content_type)

        def _summary(self, interview) -> Dict[str, Any]:
            state = lab.sessions.load(interview.id)
            return {**interview.public(), "status": state["status"] if state else "not started",
                    "workspace_exists": bool(read_marker(workspace_path(interview, lab.home)))}

        def _state(self, interview) -> Dict[str, Any]:
            status = lab.sessions.status(interview)
            usage = status.get("state", {}).get("api_usage") if status.get("started") else None
            report, _ = grading.latest_report(interview, lab.home)
            workspace = workspace_path(interview, lab.home)
            python = test_python(lab.home)
            return {
                "interview": interview.public(),
                "task": interview.task(),
                "session": status,
                "api": lab.api.public(usage),
                "has_report": report is not None,
                "workspace": str(workspace),
                "workspace_exists": bool(read_marker(workspace)),
                "commands": {
                    "editor": f'code "{workspace}"',
                    "assistant": f'cd "{workspace}" && claude',
                    "tests": f'cd "{workspace}" && "{python}" -m pytest -q',
                    "activate": f'source "{lab.home / ".venv" / "bin" / "activate"}"',
                },
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

        def _run_visible(self, interview) -> Dict[str, Any]:
            workspace = workspace_path(interview, lab.home)
            if not read_marker(workspace):
                raise WorkspaceError("Start the interview first, so the workspace exists.")
            result = run_pytest(test_python(lab.home), workspace, ["tests"])
            if lab.sessions.load(interview.id):
                lab.sessions.record_test_run(interview, summary(result))
            return {"result": {**summary(result), "output": result["output"], "cases": [{"name": c["id"].split("::", 1)[-1] if not c["collection_error"] else c["name"], "outcome": c["outcome"], "message": c["message"]} for c in result["cases"]]}}

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


def make_server(lab: Lab, port: int = 8765) -> ThreadingHTTPServer:
    holder = {"port": port}
    server = ThreadingHTTPServer(("127.0.0.1", port), _handler(lab, holder))
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
