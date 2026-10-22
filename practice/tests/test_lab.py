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


def test_api_mode_is_off_by_default(tmp_path):
    config = api.ApiConfig(env={"ANTHROPIC_API_KEY": "sk-test"})
    assert not config.enabled and not config.public()["ready"]
    with pytest.raises(api.ApiError) as error:
        api.complete(config, "s", "p", {}, tmp_path)
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


def test_follow_ups_leave_out_the_guides_answers():
    orders = get_interview("commerce-orders")
    followups = orders.followups()
    assert followups[0] == "How would idempotency work across two app servers?"
    assert not any("shared store" in f or "(" in f for f in followups)
    for interview in all_interviews():
        assert len(interview.followups()) >= 2


def test_interviewer_cues_once_and_runs_out_of_follow_ups():
    import tempfile

    with tempfile.TemporaryDirectory() as home:
        sessions = Sessions(Path(home))
        orders = get_interview("commerce-orders")
        sessions.start(orders)
        first = sessions.cue(orders, "start")
        assert first["source"] == "interviewer" and "interviewer" in first["answer"]
        assert sessions.cue(orders, "start") is None
        plan = [sessions.follow_up(orders, "plan") for _ in range(len(interviewer.PLAN_PROMPTS) + 1)]
        assert plan[-1] is None and plan[0]["answer"] == interviewer.PLAN_PROMPTS[0]
        assert sessions.follow_up(orders, "explain")["answer"] == orders.followups()[0]
        state = sessions.load("commerce-orders")
        assert [q["kind"] for q in state["questions"]][:2] == ["cue:start", "followup:plan"]


def test_spoken_walkthrough_counts_as_evidence(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setenv("PRACTICE_PYTHON", sys.executable)
    sessions = Sessions(tmp_path, clock=lambda: clock[0])
    orders = get_interview("commerce-orders")
    sessions.start(orders)
    sessions.cue(orders, "start")
    sessions.record_speech(orders, "I looked at orders/service.py first because place_order owns the whole flow.")
    clock[0] += 52 * 60
    sessions.record_speech(orders, "I fixed the duplicate lookup because it checked the wrong dictionary, and I verified it with a regression test. "
                                   "The tradeoff is that request ids are kept forever, which I would expire in production.")
    state = sessions.load("commerce-orders")
    notes = {key: "" for key in ("plan", "assumptions", "patch_review", "explanation", "transcript")}
    notes["spoken"] = "\n".join(s["text"] for s in state["spoken"])
    notes["spoken_late"] = state["spoken"][1]["text"]
    pu_score, evidence, _ = grading._score_problem_understanding(orders, state, notes)
    assert pu_score is None  # interviewer lines are not the candidate's questions
    assert grading._score_exploration(orders, notes)[0] is not None
    score, evidence, missing = grading._score_communication(orders, notes)
    assert score >= 3 and "spoken words" in evidence[0]


def test_amazon_behavioral_flow_asks_every_question_and_follow_up_in_order(tmp_path):
    sessions = Sessions(tmp_path)
    round1 = get_interview("amazon-final-1")
    sessions.start(round1)
    sessions.record_answer(round1, "Hi, I'm a sophomore studying computer science.")  # before any question: think-aloud
    plan = sessions.load("amazon-final-1")["behavioral"]["plan"]
    assert len(plan) == 2 and len({item["lp"] for item in plan}) == 2
    expected = [p for q in plan for p in [q["question"], *q["followups"]]]
    asked = []
    while True:
        entry = sessions.behavioral_next(round1)
        if entry is None:
            break
        asked.append(entry["answer"])
        assert sessions.behavioral_next(round1) is None  # waits for an answer before the next prompt
        sessions.record_answer(round1, f"answer {len(asked)}")
    assert asked == expected
    state = sessions.load("amazon-final-1")
    assert [len(a["parts"]) for a in state["behavioral"]["answers"]] == [len(q["followups"]) + 1 for q in plan]
    assert state["spoken"][0]["text"].startswith("Hi, I'm a sophomore")


def test_claude_words_behavioral_prompts_without_changing_the_plan(tmp_path):
    from interview_lab import coach_ai
    sessions = Sessions(tmp_path)
    round_ = get_interview("amazon-behavioral")
    sessions.start(round_)
    plan = sessions.load("amazon-behavioral")["behavioral"]["plan"]
    sessions.record_answer(round_, "Hi, I'm Jordan, a junior. I interned at Northwind Labs last summer.")  # the introduction
    before = sessions.load("amazon-behavioral")
    step = sessions.behavioral_step(round_)
    assert step["kind"] == "behavioral:question" and step["index"] == 0
    assert sessions.behavioral_step(round_) is None  # one prompt at a time, even before it's said
    opening = coach_ai.build_behavioral_prompt(round_, before, "Jordan Lee\nNorthwind Labs, Software Intern", 70, step, opening=True)
    assert "finished introducing themselves" in opening and plan[0]["question"] in opening and f"[{plan[0]['lp']}]" in opening
    assert "Northwind Labs, Software Intern" in opening and "Candidate: Hi, I'm Jordan" in opening
    entry = sessions.record_behavioral_prompt(round_, step, "Thanks, Jordan. Tell me about a time you owned something end to end.")
    assert entry["kind"] == "behavioral:question" and entry["source"] == "interviewer"
    sessions.record_answer(round_, "At Northwind I rebuilt the signup loader myself.")
    step = sessions.behavioral_step(round_)
    followup = coach_ai.build_behavioral_prompt(round_, sessions.load("amazon-behavioral"), "", 300, step)
    assert f'The planned one is: "{plan[0]["followups"][0]}"' in followup and "rebuilt the signup loader" in followup and "hasn't added a résumé" in followup
    sessions.record_behavioral_prompt(round_, step, "  ")  # nothing usable came back: the plan's own words
    answers = sessions.load("amazon-behavioral")["behavioral"]["answers"]
    assert answers[0]["prompts"] == ["Thanks, Jordan. Tell me about a time you owned something end to end.", plan[0]["followups"][0]]
    assert len(coach_ai.SYSTEM) < 8000


def test_a_skipped_cue_is_not_said_later(tmp_path):
    from interview_lab.session import SessionError
    sessions = Sessions(tmp_path)
    round_ = get_interview("amazon-behavioral")
    sessions.start(round_)
    sessions.skip_cue(round_, "amz_behavioral")
    assert sessions.cue(round_, "amz_behavioral") is None
    assert not any(q.get("kind") == "cue:amz_behavioral" for q in sessions.load(round_.id)["questions"])
    with pytest.raises(SessionError):
        sessions.skip_cue(round_, "nonsense")


def test_amazon_rounds_are_an_hour_with_time_checks_while_you_code():
    for interview_id in ("amazon-final-1", "amazon-final-2"):
        interview = get_interview(interview_id)
        phases = interview.phases()
        assert interview.meta["duration_minutes"] == 60 and phases[-1]["end"] == 60
        assert all(a["end"] == b["start"] for a, b in zip(phases, phases[1:]))
        code = next(p for p in phases if p.get("cue") == "amz_code")
        assert code["start"] < interview.meta["change_at_minutes"] < code["end"] and [c["left"] for c in code["checks"]] == [10, 5]
        cues = interviewer.cues_for(interview)
        assert all(c["cue"] in cues for c in code["checks"]) and "amz_wrap_early" in cues and "60-minute" in interview.task()


def test_a_long_story_gets_fewer_follow_ups_so_both_questions_fit(tmp_path):
    now = [0.0]
    sessions = Sessions(tmp_path, clock=lambda: now[0])
    round1 = get_interview("amazon-final-1")
    sessions.start(round1)
    plan = sessions.load(round1.id)["behavioral"]["plan"]
    now[0] = 3 * 60
    first = sessions.behavioral_step(round1)
    assert first["kind"] == "behavioral:question" and first["seconds_left"] == round((20 * 60 - 180) / 2)
    sessions.record_behavioral_prompt(round1, first, first["text"])
    sessions.record_answer(round1, "A long story.")
    now[0] = 6 * 60
    followup = sessions.behavioral_step(round1)
    assert followup["kind"] == "behavioral:followup" and followup["text"] == plan[0]["followups"][0]
    sessions.record_behavioral_prompt(round1, followup, followup["text"])
    sessions.record_answer(round1, "More of it.")
    now[0] = 12 * 60   # past the first story's share (8.5 minutes from minute 3)
    second = sessions.behavioral_step(round1)
    assert second["kind"] == "behavioral:question" and second["hurried"] and second["index"] == 1
    assert second["text"] == "In the interest of time, let's move on. " + plan[1]["question"]
    sessions.record_behavioral_prompt(round1, second, second["text"])
    sessions.record_answer(round1, "The second story.")
    now[0] = 19 * 60   # the last question keeps its follow-ups until the questions' time runs out
    assert sessions.behavioral_step(round1)["kind"] == "behavioral:followup"
    sessions.record_answer(round1, "Detail.")
    now[0] = 20 * 60 + 5
    assert sessions.behavioral_step(round1) is None
    flow = sessions.load(round1.id)["behavioral"]
    assert [a["asked_at"] for a in flow["answers"]] == [180, 720]


def test_the_interviewer_moves_on_when_you_finish_a_part_early(tmp_path):
    now = [0.0]
    sessions = Sessions(tmp_path, clock=lambda: now[0])
    round1 = get_interview("amazon-final-1")
    sessions.start(round1)
    names = [p["name"] for p in round1.phases()]
    now[0] = 12 * 60   # the questions are done early: the coding problem comes now
    entry = sessions.move_on(round1, "amz_clarify")
    assert entry["kind"] == "cue:amz_clarify" and names[sessions.status(round1)["phase"]] == "Read and clarify the coding problem"
    assert sessions.move_on(round1, "amz_clarify") is None
    now[0] = 14 * 60   # you start coding while reading: the coding part starts, and "go ahead and code it" isn't said later
    sessions.record_edit(round1)
    state = sessions.load(round1.id)
    assert names[sessions.status(round1)["phase"]] == "Code it and talk it through" and "amz_code" in state["cues"]
    assert state["coding"] == {"first_edit": 840, "edits": 1, "last_edit": 840}
    now[0] = 30 * 60   # the tests pass: the follow-up comes before its minute
    assert sessions.reveal_when_solved(round1) and not sessions.reveal_when_solved(round1)
    assert sessions.load(round1.id)["change_reveal_reason"] == "solved"
    now[0] = 38 * 60   # done coding: on to the dry run and your questions, in words that fit finishing early
    done = sessions.done_coding(round1)
    assert done["next"] == "wrap" and done["entry"]["kind"] == "cue:amz_wrap_early" and names[sessions.status(round1)["phase"]].startswith("Dry run")
    assert sessions.cue(round1, "amz_wrap") is None   # the clock's own wrap-up line isn't said on top of it


def test_time_saved_early_goes_to_the_coding(tmp_path):
    now = [0.0]
    sessions = Sessions(tmp_path, clock=lambda: now[0])
    round1 = get_interview("amazon-final-1")
    sessions.start(round1)
    now[0] = 12 * 60
    sessions.move_on(round1, "amz_clarify")
    status = sessions.status(round1)
    assert status["bounds"][2] == [12, 17] and status["bounds"][3] == [17, 50]   # reading keeps its five minutes
    now[0] = 17.5 * 60   # still reading when its time is up: the coding part has begun, with the time saved
    assert round1.phases()[sessions.status(round1)["phase"]]["cue"] == "amz_code"
    assert sessions.cue(round1, "amz_code")["answer"].startswith("We have about 32 minutes for coding.")


def test_done_coding_before_the_follow_up_brings_the_follow_up(tmp_path):
    now = [0.0]
    sessions = Sessions(tmp_path, clock=lambda: now[0])
    round1 = get_interview("amazon-final-1")
    sessions.start(round1)
    now[0] = 30 * 60
    done = sessions.done_coding(round1)
    state = sessions.load(round1.id)
    assert done == {"next": "followup", "entry": None} and state["change_reveal_reason"] == "done" and state["coding"]["done"] == [1800]


def test_the_report_times_each_part_against_the_plan(tmp_path):
    round1 = get_interview("amazon-final-1")
    plan = [{"lp": "Ownership", "question": "q1", "followups": []}, {"lp": "Bias for Action", "question": "q2", "followups": []}]
    cue = lambda name, at: {"at": at, "source": "interviewer", "kind": f"cue:{name}", "answer": "", "question": ""}
    state = {"questions": [cue("amz_intro", 0), cue("amz_clarify", 21 * 60), cue("amz_wrap", 50 * 60),
                           {"at": 22 * 60, "source": "offline", "question": "Can k be zero?", "answer": "Yes."}],
             "behavioral": {"plan": plan, "answers": [{"lp": "Ownership", "asked_at": 150, "prompts": ["q1", "f"]}, {"lp": "Bias for Action", "asked_at": 15 * 60, "prompts": ["q2"]}]},
             "coding": {"first_edit": 31 * 60, "edits": 40}, "change_revealed_at": 42 * 60}
    timeline = grading.time_breakdown(round1, state, 56 * 60)
    parts = {p["part"]: (p["minutes"], p["planned"]) for p in timeline["parts"]}
    assert parts == {"Introductions": (2.5, 3), "Leadership Principles": (18.5, 17), "Reading and clarifying": (10.0, 5),
                     "Coding the problem": (11.0, 17), "The follow-up": (8.0, 8), "Dry run and your questions": (6.0, 10)}
    assert timeline["coding_minutes"] == 19.0 and [s["minutes"] for s in timeline["stories"]] == [12.5, 6.0]
    assert any("started coding 10 minutes after" in n for n in timeline["notes"]) and any("Ownership story took 12" in n for n in timeline["notes"])
    assert grading.time_breakdown(get_interview("lru-cache"), state, 60) is None


def test_leadership_scores_owned_specific_stories_above_vague_ones():
    round1 = get_interview("amazon-final-1")
    strong = ("Last summer during my internship I noticed our test suite took 40 minutes and nobody owned it. My goal was to get it under ten. "
              "I profiled it, I found three slow fixtures, I rewrote them and I set up parallel runs. As a result it dropped to 8 minutes, "
              "an 80% cut, and the team shipped twice as often. Looking back, I learned to measure first. ") * 2
    vague = "We had a project and we worked hard on it as a team and we finished it."
    def state_with(text):
        return {"behavioral": {"answers": [{"question": "Tell me about a time you took on something that wasn't your job.", "lp": "Ownership", "prompts": ["q"], "parts": [{"at": 1, "text": text}]}]}}
    good, good_evidence, _ = grading._score_leadership(round1, state_with(strong))
    bad, _, missing = grading._score_leadership(round1, state_with(vague))
    assert good >= 4 and bad <= 2
    assert any("“I” more than “we”" in m for m in missing)
    assert "(Ownership)" in good_evidence[0]


def test_amazon_rounds_are_no_ai_but_run_code_in_the_browser_editor(tmp_path):
    from interview_lab.workspace import create_workspace
    for interview_id in ("amazon-final-1", "amazon-final-2"):
        interview = get_interview(interview_id)
        public = interview.public()
        assert not interview.ai_allowed and public["run_tests_allowed"] is True
        assert public["editor_files"] == interview.meta["source_files"] and public["custom_input"]
        workspace = create_workspace(interview, tmp_path)
        assert "Do not help with the exercise" in (workspace / "CLAUDE.md").read_text()
        assert not (workspace / "patch_review").exists()
        assert [a for a, _ in grading.areas_for(interview)] == [a for a, _ in grading.AMAZON_AREAS]
        assert [p["name"] for p in public["phases"]][1] == "Leadership Principles questions" and "cue" not in public["phases"][0]


STORIES = [
    ["Last fall in my robotics club I was responsible for the drive code before regionals, and {signals} mattered most. I decided to rewrite the "
     "motor controller, I profiled it on the practice field and I added unit tests for each sensor. As a result our autonomous score went up 40% "
     "and we placed third. Looking back, I learned to test on real hardware early.",
     "Personally I wrote the controller and the sensor tests; two teammates handled the chassis.",
     "We logged autonomous points over six practice matches: from about 12 to 17 on average.",
     "I'd book field time a week sooner, since we nearly ran out of tuning sessions."],
    ["During my data structures course, my lab partner and I disagreed about using a trie, and {signals} came into it. I proposed benchmarking "
     "both designs, I wrote a script with ten thousand words and I shared the numbers. As a result we picked the hash map, which ran 3x faster, "
     "and we got full marks. In hindsight, I realized data ends arguments faster than opinions.",
     "My own part was the benchmark script and the write-up comparing memory use.",
     "The grader's timing harness showed 0.8 seconds against 2.4 for the trie version.",
     "Next time I would agree on how to decide before we started arguing about designs."],
    ["At a weekend hackathon our payment demo broke two hours before judging, and {signals} drove what I did. I traced the failure to an expired "
     "sandbox key, I set up a mock gateway and I rewired the checkout in forty minutes. As a result we demoed on time and won the fintech prize "
     "out of 25 teams. I learned to keep a fallback for every external dependency.",
     "I built the mock gateway myself while my teammate rehearsed the pitch.",
     "Judges scored the demo 9 out of 10; the only deduction was for styling.",
     "I'd test third-party keys at the start of the event instead of the end."],
    ["As a peer tutor at the campus writing center, I noticed new tutors were overwhelmed, and {signals} was the heart of it. I created a "
     "one-page guide, I paired each new tutor with a senior one, and I ran a short training. As a result session ratings rose from 3.9 to 4.6 "
     "and turnover fell by half. Looking back, I'd involve the new tutors in writing the guide.",
     "The guide and the pairing schedule were mine; the director approved the training slot.",
     "We tracked ratings for eight weeks and compared them with the previous semester.",
     "I would survey tutors before designing anything, rather than guessing what they needed."],
]


def _story_for(item, n):
    """A distinct, owned, measured story that shows the principle (two of its signals), with new detail per follow-up."""
    parts = list(STORIES[n % len(STORIES)])
    parts[0] = parts[0].format(signals=" and ".join(item["signals"][:2]))
    return parts


def test_behavioral_round_scores_each_story_and_breaks_it_down_by_principle(tmp_path):
    sessions = Sessions(tmp_path)
    round_ = get_interview("amazon-behavioral")
    sessions.start(round_)
    plan = sessions.load("amazon-behavioral")["behavioral"]["plan"]
    answers = {i: _story_for(item, i) for i, item in enumerate(plan)}
    while True:
        entry = sessions.behavioral_next(round_)
        if entry is None:
            break
        flow = sessions.load("amazon-behavioral")["behavioral"]
        sessions.record_answer(round_, answers[flow["question"]][flow["followup"]])
    state = sessions.load("amazon-behavioral")
    rows = grading.lp_breakdown(round_, state)
    assert [r["lp"] for r in rows] == [item["lp"] for item in plan] and len(rows) == 4
    assert all(row["score"] >= 3 for row in rows) and sum(row["score"] for row in rows) / len(rows) >= 3.5, rows
    scores = grading._behavioral_scores(round_, state, {})
    assert set(scores) == {a for a, _ in grading.BEHAVIORAL_AREAS}
    assert scores["impact"][0] >= 4 and scores["star"][0] >= 4 and scores["followups"][0] == 5


def test_reused_stories_and_repeated_follow_ups_lose_points(tmp_path):
    sessions = Sessions(tmp_path)
    round_ = get_interview("amazon-behavioral")
    sessions.start(round_)
    plan = sessions.load("amazon-behavioral")["behavioral"]["plan"]
    same = _story_for(plan[0], 0)[0]
    while sessions.behavioral_next(round_):
        sessions.record_answer(round_, same)  # one story, repeated for every question and follow-up
    rows = grading.lp_breakdown(round_, sessions.load("amazon-behavioral"))
    assert all(row["score"] <= 2 for row in rows[1:]) and any("reuses your" in m for m in rows[1]["missing"])
    assert any("repeated what you'd already said" in m for m in rows[0]["missing"])


def test_practice_problems_are_listed_in_the_weekend_order():
    numbers = [i.meta["number"] for i in all_interviews() if i.meta.get("format") == "problem"]
    assert numbers == [146, 200, 767, 1, 3, 5, 875, 56, 49, 560, 994, 210, 33, 236, 253]
    for interview in all_interviews():
        if interview.meta.get("format") == "problem":
            assert len(interview.hints()) == 3 and interview.approach() and interview.meta["editor_files"] == ["solution.py"]
            assert "leetcode.com/problems/" in interview.meta["leetcode"]


def test_coach_mode_explains_concepts_and_real_mode_does_not():
    problem = get_interview("koko-eating-bananas")
    assert not interviewer.answer(problem, "How does binary search work?", False, "real")["matched"]
    coached = interviewer.answer(problem, "How does binary search work?", False, "coach")
    assert coached["matched"] and "O(log n)" in coached["answer"]
    assert interviewer.answer(problem, "Is h always at least the number of piles?", False, "coach")["answer"].startswith("Good question")
    assert interviewer.cues_for(problem, "coach")["p_intro"].startswith("Hey!") and interviewer.cues_for(problem, "real")["p_intro"].startswith("Hi!")


def test_coach_prompt_includes_code_tests_and_conversation(tmp_path):
    from interview_lab import coach_ai
    from interview_lab.workspace import create_workspace
    problem = get_interview("two-sum")
    workspace = create_workspace(problem, tmp_path)
    (workspace / "solution.py").write_text("def two_sum(nums, target):\n    return [0, 1]  # my attempt\n")
    state = {"mode": "coach", "questions": [{"at": 5, "question": "Can values repeat?", "answer": "Yes.", "source": "coach-ai"}],
             "spoken": [{"at": 9, "text": "I think a hash map works"}], "hints": [],
             "last_test_run": {"at": 60, "passed": 1, "failed": 1, "errors": 0, "failing": [{"name": "test_examples", "message": "assert [0, 1] == [2, 3]"}]}}
    prompt = coach_ai.build_prompt(problem, state, workspace, 120, "Code it and test it", "hint", hint={"level": 1, "total": 3, "text": problem.hints()[0]})
    assert "# my attempt" in prompt and "assert [0, 1] == [2, 3]" in prompt
    assert "Candidate: Can values repeat?" in prompt and "thinking aloud): I think a hash map works" in prompt
    assert "1 of 3" in prompt and problem.hints()[0] in prompt
    assert len(coach_ai.SYSTEM) < 8000 and "text-to-speech" in coach_ai.SYSTEM


def test_real_interviewer_prompt_probes_instead_of_teaching(tmp_path):
    from interview_lab import coach_ai
    from interview_lab.workspace import create_workspace
    problem = get_interview("merge-intervals")
    workspace = create_workspace(problem, tmp_path)
    real = coach_ai.build_prompt(problem, {"mode": "real", "questions": [], "spoken": [], "hints": []}, workspace, 60, "Explain your approach", "message", "Is sorting optimal?")
    coach = coach_ai.build_prompt(problem, {"mode": "coach", "questions": [], "spoken": [], "hints": []}, workspace, 60, "Explain your approach", "message", "Is sorting optimal?")
    assert "You are the INTERVIEWER" in real and "don't confirm that their idea is right" in real and "never reveal it" in real
    assert "You are the COACH" in coach and "Socratic" in coach
    assert problem.followups()[0] in real  # the real interviewer asks these at the end
    assert real.rstrip().endswith("Reply as the interviewer, in one or two short spoken sentences.")


def test_hints_only_advance_after_progress(tmp_path):
    import time as clock
    sessions = Sessions(tmp_path)
    problem = get_interview("group-anagrams")
    sessions.start(problem, mode="coach")
    first = sessions.take_hint(problem)
    assert first["level"] == 1 and not first["repeat"]
    again = sessions.take_hint(problem)
    assert again["level"] == 1 and again["repeat"] and len(sessions.load(problem.id)["hints"]) == 1
    clock.sleep(0.7)
    (tmp_path / problem.id / "solution.py").write_text("def group_anagrams(words):\n    return []\n")   # an edit counts as progress
    second = sessions.take_hint(problem)
    assert second["level"] == 2 and not second["repeat"]
    sessions.ask(problem, "Can words repeat?")
    assert sessions.take_hint(problem)["level"] == 3


def test_windows_gets_its_own_paths_and_powershell_commands():
    from pathlib import PureWindowsPath
    from interview_lab.catalog import claude_rule_path, shell_commands, venv_python

    assert venv_python(Path("/home/me/.venv"), windows=False) == Path("/home/me/.venv/bin/python")
    assert venv_python(Path("/home/me/.venv"), windows=True) == Path("/home/me/.venv/Scripts/python.exe")
    # Claude Code writes Windows paths in permission rules as //c/Users/...
    assert claude_rule_path(Path("/Users/me/localtest/practice"), windows=False) == "//Users/me/localtest/practice"
    assert claude_rule_path(PureWindowsPath(r"C:\Users\me\localtest\practice"), windows=True) == "//c/Users/me/localtest/practice"
    workspace, venv = PureWindowsPath(r"C:\Users\me\interview-practice\two-sum"), PureWindowsPath(r"C:\Users\me\interview-practice\.venv")
    commands = shell_commands(workspace, str(venv / "Scripts" / "python.exe"), venv, windows=True)
    assert commands["assistant"] == f'cd "{workspace}"; claude'   # PowerShell 5 has no &&
    assert commands["tests"].endswith(f'; & "{venv}\\Scripts\\python.exe" -m pytest -q')
    assert commands["activate"] == f'& "{venv}\\Scripts\\Activate.ps1"'
    assert "&&" in shell_commands(Path("/w"), "/v/bin/python", Path("/v"), windows=False)["assistant"]


def test_dashboard_serves_its_script_as_javascript_whatever_the_system_says(tmp_path, monkeypatch):
    # On Windows, Python's file types come from the registry, which can call .js plain text; with nosniff the page would break.
    import mimetypes
    import urllib.request
    from interview_lab.server import Lab, make_server

    monkeypatch.setattr(mimetypes, "guess_type", lambda *args, **kwargs: ("text/plain", None))
    server = make_server(Lab(tmp_path, api_config=api.ApiConfig(env={})), port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/static/app.js") as response:
            assert response.headers["Content-Type"] == "text/javascript; charset=utf-8"
    finally:
        server.shutdown()
        server.server_close()


def test_workspace_points_vs_code_and_claude_code_at_the_right_places(tmp_path):
    from interview_lab.catalog import LAB_ROOT, claude_rule_path, venv_python

    workspace = create_workspace(get_interview("two-sum"), tmp_path)
    vscode = json.loads((workspace / ".vscode" / "settings.json").read_text(encoding="utf-8"))
    assert vscode["python.defaultInterpreterPath"] == str(venv_python(tmp_path / ".venv"))
    deny = json.loads((workspace / ".claude" / "settings.json").read_text(encoding="utf-8"))["permissions"]["deny"]
    assert f"Read({claude_rule_path(LAB_ROOT)}/**)" in deny


def test_resume_parser_finds_roles_and_projects_and_builds_the_scripted_plan(tmp_path):
    from interview_lab import resume
    text = ("Alex Example\nalex@example.com\n\nEXPERIENCE\nAmazon — Software Development Engineer Intern\nSeattle, WA  June 2025 – Aug 2025\n"
            "• Built a service\n\nPROJECTS\nChess Engine | C++, Python\n• Fast search\n\nSKILLS\nC++, Go, Python\n")
    assert resume.items(text) == [("role", "your Software Development Engineer Intern role at Amazon"), ("project", "Chess Engine")]
    assert {"Amazon", "C++", "Python"} <= set(resume.terms(text)) and "Built" not in resume.terms(text) and "Alex" not in resume.terms(text)
    # The common two-line layout: company and city, then role and dates; wrapped bullet lines lose their bullet.
    two_line = ("Experience\nGoogle Mountain View, CA\nSoftware Engineering Intern, Search Jun 2025 – Aug 2025\n• Cut p95 latency by\n30% across the service.\n"
                "Northwind Labs Bedford, MA\nRobotics Intern – Automation Jan 2025 – May 2025\nProjects & Activities\nTrailMix — 1st Place, Campus Hack July 2026\n"
                "Python, SQLite, TypeScript\nSoftware & Firmware Engineer\n")
    assert resume.items(two_line) == [("role", "your Software Engineering Intern role at Google"), ("role", "your Robotics Intern role at Northwind Labs"), ("project", "TrailMix")]
    principles = [{"lp": "Ownership", "id": "own-1", "question": "Tell me about a time you owned something.", "followups": ["What did you do?"]},
                  {"lp": "Earn Trust", "id": "trust-1", "question": "Tell me about a time you rebuilt trust.", "followups": ["How?"]}]
    plan = resume.plan(text, principles)
    assert "walk me through your background" in plan[0]["question"]
    assert "Amazon" in plan[1]["question"] and "Chess Engine" in plan[2]["question"] and "questions do you have" in plan[-1]["question"]
    assert plan[3]["section"] == "Leadership Principles" and plan[3]["question"] == resume.LP_INTRO + "Tell me about a time you owned something."
    assert plan[4]["lp"] == "Earn Trust" and "section" not in plan[4]
    with pytest.raises(ValueError):
        resume.save(tmp_path, "empty.pdf", "   ")
    resume.save(tmp_path, "cv.pdf", text)
    assert resume.summary(resume.load(tmp_path))["name"] == "cv.pdf"
    resume.forget(tmp_path)
    assert resume.load(tmp_path) is None


def test_resume_turns_keep_the_order_things_were_said_in_the_same_moment():
    from interview_lab import grading
    interview = get_interview("resume-deep-dive")
    state = {"questions": [
        {"at": 5.0, "n": 1, "source": "interviewer", "answer": "Walk me through your background."},
        {"at": 5.0, "n": 3, "source": "interviewer", "answer": "Let's switch gears. Tell me about a time you disagreed with a teammate.", "section": "Leadership Principles"},
    ], "behavioral": {"answers": [{"parts": [{"at": 5.0, "n": 2, "text": "I'm a junior studying CS, most recently an intern."},
                                             {"at": 5.0, "n": 4, "text": "I disagreed about caching and I measured it."}]}]}}
    turns = grading.resume_turns(interview, state)
    assert [t["kind"] for t in turns] == ["walkthrough", "leadership"]
    assert turns[1]["prompt"].startswith("Let's switch gears") and turns[1]["principle"] == 0


def test_resume_interviewer_keeps_time_and_closes():
    from interview_lab import coach_ai
    interview = get_interview("resume-deep-dive")
    state = {"questions": [], "spoken": []}
    early = coach_ai.build_resume_prompt(interview, state, "Jordan Lee\nPROJECTS\nStudySync", 60, "message", "I built StudySync.")
    assert '"Your background"' in early and "I built StudySync." in early and "StudySync" in early.split("Interview plan")[0]
    assert 'move to "Your questions for me" now' in coach_ai.build_resume_prompt(interview, state, "x", 26.5 * 60, "message", "ok")
    assert "Time's up" in coach_ai.build_resume_prompt(interview, state, "x", 30.5 * 60, "message", "ok")


def test_resume_transcript_labels_who_said_what():
    from interview_lab import coach_ai
    state = {"questions": [
        {"at": 1.0, "n": 1, "source": "interviewer", "answer": "Walk me through your background."},
        {"at": 9.0, "n": 3, "source": "coach-ai", "question": "I interned at Acme on payments.", "answer": "What did you build there?"},
    ], "spoken": [], "behavioral": {"answers": [{"parts": [{"at": 5.0, "n": 2, "text": "I'm a junior studying CS."}]}]}}
    assert coach_ai._resume_conversation(state).splitlines() == [
        "Interviewer: Walk me through your background.",
        "Candidate: I'm a junior studying CS.",
        "Candidate: I interned at Acme on payments.",
        "Interviewer: What did you build there?",
    ]


def test_resume_principles_follow_the_interviewer_to_the_next_question():
    from interview_lab import grading
    interview = get_interview("resume-deep-dive")
    asked = [{"lp": "Ownership", "question": "Tell me about a time you took on something that wasn't your responsibility because you saw it needed doing.", "followups": []},
             {"lp": "Earn Trust", "question": "Tell me about a time you had to rebuild trust with someone after something went wrong.", "followups": []}]
    state = {"behavioral": {"plan": asked, "answers": []}, "questions": [
        {"at": 60.0, "n": 1, "source": "interviewer", "answer": "Walk me through your background."},
        {"at": 1100.0, "n": 2, "source": "coach-ai", "question": "I'm a junior.", "section": "Leadership Principles",
         "answer": "Switching gears to behavioral questions. Tell me about a time you took on something that wasn't your job because it needed doing."},
        {"at": 1200.0, "n": 3, "source": "coach-ai", "question": "At my internship I owned the flaky test suite nobody fixed. I rewrote it and failures dropped 80%.", "answer": "What did you learn?"},
        {"at": 1300.0, "n": 4, "source": "coach-ai", "question": "I learned to ask early.", "answer": "Okay. Tell me about a time you had to rebuild trust with someone after something went wrong."},
        {"at": 1400.0, "n": 5, "source": "coach-ai", "question": "I missed a deadline for my teammate, so I told them right away and stayed late to fix it.", "answer": "What questions do you have for me?"},
    ]}
    turns = grading.resume_turns(interview, state)
    assert [(t["kind"], t["principle"]) for t in turns] == [("walkthrough", None), ("leadership", 0), ("leadership", 0), ("leadership", 1)]
    assert [s["lp"] for s in grading.resume_principles(interview, state, turns)] == ["Ownership", "Earn Trust"]


def test_the_principles_section_shows_as_the_current_phase_once_it_starts(tmp_path):
    interview = get_interview("resume-deep-dive")
    now = [1000.0]
    sessions = Sessions(tmp_path, clock=lambda: now[0])
    sessions.start(interview)
    now[0] += 18.5 * 60
    names = lambda: sessions.status(interview)["phases"][sessions.status(interview)["phase"]]["name"]
    assert names() == "Deep dive: a second experience"
    sessions.record_coach(interview, "message", "That's how the matcher worked.", "Let's switch gears. Tell me about a time…", section="Leadership Principles")
    assert names() == "Leadership Principles"
