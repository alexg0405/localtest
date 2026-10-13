"""Unit tests for the lab itself (not the interviews). Run: <venv>/bin/python -m pytest practice/tests -q"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from interview_lab import api, grading, interviewer  # noqa: E402
from interview_lab.catalog import all_interviews, get_interview  # noqa: E402
from interview_lab.session import Sessions  # noqa: E402
from interview_lab.workspace import WorkspaceError, create_workspace, reset_workspace  # noqa: E402


class FakeApi:
    """A stand-in for the Messages API that replies with scripted (status, body, headers)."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fake.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                status, payload, headers = fake.replies.pop(0)
                data = json.dumps(payload).encode()
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def ok_reply(text="Use the request_id.", input_tokens=120, output_tokens=30):
    return (200, {"content": [{"type": "text", "text": text}], "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}, "model": "claude-test", "stop_reason": "end_turn"}, {})


def config_for(fake, **extra):
    env = {"PRACTICE_API_MODE": "on", "ANTHROPIC_API_KEY": "sk-test", "ANTHROPIC_BASE_URL": fake.url, **extra}
    return api.ApiConfig(env=env)


def test_api_mode_is_off_by_default():
    config = api.ApiConfig(env={"ANTHROPIC_API_KEY": "sk-test"})
    assert not config.enabled and not config.public()["ready"]
    with pytest.raises(api.ApiError) as error:
        api.complete(config, "s", "p", {}, Path("/tmp"))
    assert error.value.kind == "off"


def test_missing_key_is_reported(tmp_path):
    config = api.ApiConfig(env={"PRACTICE_API_MODE": "on"})
    assert "not set" in config.public()["message"]
    with pytest.raises(api.ApiError) as error:
        api.complete(config, "s", "p", {}, tmp_path)
    assert error.value.kind == "missing_key"


def test_successful_request_caps_output_and_tracks_usage(tmp_path):
    fake = FakeApi([ok_reply()])
    try:
        config = config_for(fake, PRACTICE_API_MAX_OUTPUT_TOKENS="250", PRACTICE_API_MODEL="claude-test")
        result = api.complete(config, "system", "question", {"requests": 0}, tmp_path)
    finally:
        fake.close()
    assert result["text"] == "Use the request_id." and result["usage"] == {"input_tokens": 120, "output_tokens": 30}
    sent = fake.requests[0]
    assert sent["path"] == "/v1/messages" and sent["body"]["max_tokens"] == 250 and sent["body"]["model"] == "claude-test"
    assert sent["headers"]["x-api-key"] == "sk-test" and sent["headers"]["anthropic-version"] == api.API_VERSION
    totals = json.loads((tmp_path / ".lab" / "api_usage.json").read_text())
    assert totals["requests"] == 1 and totals["input_tokens"] == 120 and totals["output_tokens"] == 30


def test_request_cap_stops_before_calling(tmp_path):
    fake = FakeApi([])
    try:
        with pytest.raises(api.ApiError) as error:
            api.complete(config_for(fake, PRACTICE_API_MAX_REQUESTS="3"), "s", "p", {"requests": 3}, tmp_path)
    finally:
        fake.close()
    assert error.value.kind == "cap" and fake.requests == []


@pytest.mark.parametrize("status, body, headers, kind", [
    (429, {"error": {"type": "rate_limit_error", "message": "Rate limited"}}, {"retry-after": "12"}, "rate_limited"),
    (400, {"error": {"type": "invalid_request_error", "message": "Your credit balance is too low to access the Anthropic API."}}, {}, "credits"),
    (401, {"error": {"type": "authentication_error", "message": "invalid x-api-key"}}, {}, "auth"),
    (529, {"error": {"type": "overloaded_error", "message": "Overloaded"}}, {}, "overloaded"),
])
def test_api_errors_are_explained(tmp_path, status, body, headers, kind):
    fake = FakeApi([(status, body, headers)])
    try:
        with pytest.raises(api.ApiError) as error:
            api.complete(config_for(fake), "s", "p", {}, tmp_path)
    finally:
        fake.close()
    assert error.value.kind == kind
    if kind == "rate_limited":
        assert "12 seconds" in str(error.value)


def test_api_interviewer_falls_back_offline_and_counts_usage(tmp_path):
    from interview_lab.server import Lab, make_server
    import urllib.request

    fake = FakeApi([ok_reply("Same request_id means the same order."), (429, {"error": {"message": "slow down"}}, {})])
    lab = Lab(tmp_path, api_config=config_for(fake))
    server = make_server(lab, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    def post(path, body):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read())

    try:
        post("/api/start", {"interview": "commerce-orders"})
        first = post("/api/ask", {"interview": "commerce-orders", "question": "What is a duplicate request?", "use_api": True})["entry"]
        second = post("/api/ask", {"interview": "commerce-orders", "question": "What is a duplicate request?", "use_api": True})["entry"]
        state = post("/api/pause", {"interview": "commerce-orders"})
    finally:
        server.shutdown()
        server.server_close()
        fake.close()
    assert first["source"] == "api" and first["topic"] == "What makes two requests duplicates"
    assert second["source"] == "offline" and second["api_error"]["kind"] == "rate_limited" and second["matched"]
    assert state["api"]["usage"]["requests"] == 1 and state["api"]["usage"]["output_tokens"] == 30
    assert "sk-test" not in json.dumps(state)


def test_dashboard_rejects_other_hosts_and_origins(tmp_path):
    from interview_lab.server import Lab, make_server
    import urllib.error
    import urllib.request

    server = make_server(Lab(tmp_path, api_config=api.ApiConfig(env={})), port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    try:
        bad_host = urllib.request.Request(f"http://127.0.0.1:{port}/api/interviews", headers={"Host": "evil.example"})
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(bad_host)
        assert error.value.code == 403
        cross = urllib.request.Request(f"http://127.0.0.1:{port}/api/start", data=b'{"interview": "commerce-orders"}', headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(cross)
        assert error.value.code == 403
    finally:
        server.shutdown()
        server.server_close()


def test_interviewer_matches_topics_and_admits_gaps():
    orders = get_interview("commerce-orders")
    assert interviewer.answer(orders, "How many retries should a timeout get?", False)["topic"] == "Retry policy"
    assert interviewer.answer(orders, "What's the weather like?", False) == {"topic": None, "answer": interviewer.NO_ANSWER, "matched": False}
    before = interviewer.answer(orders, "Is a repeated request_id a duplicate?", False)["answer"]
    after = interviewer.answer(orders, "Is a repeated request_id a duplicate?", True)["answer"]
    assert "IdempotencyConflict" in after and "IdempotencyConflict" not in before


def test_candidate_materials_never_mention_planted_defects():
    for interview in all_interviews():
        task = interview.task().lower()
        for secret in ("planted", "reference solution", "grading test", "range(max_attempts + 1)", "utf-8-sig", "byte-order mark", "float("):
            assert secret not in task, (interview.id, secret)


def test_user_turns_reads_claude_code_exports():
    transcript = "> In orders/service.py, explain why duplicates charge twice\n  before you change anything.\n\n⏺ The lookup uses the wrong dict…\n\n> Show me the diff first, don't edit tests\n⏺ Here is the diff"
    turns = grading.user_turns(transcript)
    assert turns == ["In orders/service.py, explain why duplicates charge twice\n  before you change anything.", "Show me the diff first, don't edit tests"]
    score, evidence, missing = grading._score_ai_instructions({"transcript": transcript})
    assert score >= 4 and any("named files" in line for line in evidence)


def test_workspace_refuses_unrelated_folders(tmp_path):
    orders = get_interview("commerce-orders")
    folder = tmp_path / "commerce-orders"
    folder.mkdir()
    (folder / "important.txt").write_text("mine")
    with pytest.raises(WorkspaceError):
        create_workspace(orders, tmp_path)
    with pytest.raises(WorkspaceError):
        reset_workspace(orders, tmp_path)
    assert (folder / "important.txt").read_text() == "mine"


def test_sessions_pause_and_restart():
    clock = [1000.0]
    import tempfile

    with tempfile.TemporaryDirectory() as home:
        sessions = Sessions(Path(home), clock=lambda: clock[0])
        orders = get_interview("commerce-orders")
        sessions.start(orders)
        clock[0] += 120
        sessions.pause(orders)
        clock[0] += 600
        assert round(sessions.status(orders)["elapsed"]) == 120
        sessions.resume(orders)
        clock[0] += 60
        assert round(sessions.status(orders)["elapsed"]) == 180
        restarted = sessions.start(orders)
        assert restarted["restarts"] == 1 and sessions.status(orders)["elapsed"] == 0
