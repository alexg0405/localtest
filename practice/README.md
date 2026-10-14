# Interview Lab

Timed, local practice for AI-assisted software engineering interviews at the
internship, new-grad, and junior level, in Python with pytest. You work in a
normal editor with Claude Code as your coding assistant. A local dashboard runs
the 60-minute clock, plays the interviewer, reveals a requirement change at
minute 30, and grades your session from evidence when you submit.

It needs only Python 3.9+ and pytest: no cloud services, no database, and no API
key.

## The interviews

| ID | Scenario | What it practices |
|---|---|---|
| `commerce-orders` | An order service with double charges, a missing order in the history, and no cancel. Inspired by high-volume commerce teams such as Amazon. | Idempotency, partial-failure rollback, retries, pagination |
| `banking-ledger` | A batch ledger over a synthetic transaction feed. Balances are off by a cent, events are applied twice, and bad events slip through. Inspired by banking teams such as Capital One. | Integer-cent money, duplicate events, validation, UTC reporting |
| `unfamiliar-repo` | You're on call for a nightly import in a codebase nobody on the team wrote, and the job has started failing. | Diagnosis, a focused fix, regression tests, reviewing an AI patch |

These are original simulations, not reproductions of any company's interviews.
Each one has:
- A small starter repository with planted defects, an unfinished feature,
  visible tests, and runnable examples.
- An AI-proposed patch to review, which contains a plausible mistake.
- Hidden grading tests, an interviewer guide with answers to likely questions,
  a reference solution, and a rubric.

## Setup, start, and test

From the repository root:

```sh
python3 practice/lab.py setup     # once: creates ~/interview-practice/.venv with pytest
python3 practice/lab.py serve     # or just `npm start`: Roomside serves it at http://127.0.0.1:5173/practice/
```

If you run Roomside, you do not need a second command: `npm start` also starts Interview Lab and serves it at http://127.0.0.1:5173/practice/. Roomside's **Practice** button opens it in its own tab, and the lab's **Roomside** link switches back. `npm run practice` (or `serve`) runs the lab on its own at http://127.0.0.1:8765/. Check the lab itself:

```sh
python3 practice/lab.py verify                                        # end-to-end self-check of all three interviews
~/interview-practice/.venv/bin/python -m pytest practice/tests -q      # unit tests for the lab
```

`verify` runs in a throwaway folder. It checks that:
- The starter defects are caught by the tests.
- Each reference solution passes every grading test.
- Each AI patch applies, and its mistake is caught.
- The change appears at minute 30, and not during a pause.
- Reset restores the starter without deleting anything.
- The whole dashboard workflow runs with no API key.

Workspaces live in `~/interview-practice/<interview>/`. Set `PRACTICE_HOME` to
put them somewhere else.

## Practicing with Claude Code (subscription only)

1. In the dashboard, pick an interview and press **Start interview**. The
   dashboard shows your workspace folder.
2. Open that folder in your editor (`code ~/interview-practice/commerce-orders`).
3. Open the same folder in Claude Code, signed in with your own Claude
   subscription. Any of these works:
   - the Claude desktop app's Code tab
   - the Claude Code extension in VS Code
   - `claude` in a terminal in that folder
4. Use Claude Code as your coding assistant. Talk to the interviewer: press the
   mic in the Interviewer tab and ask out loud, or type. It answers out loud,
   speaks up at each phase and when the requirement changes, and asks follow-up
   questions when you pause while planning or explaining. Whatever you say that
   isn't a question is kept as your think-aloud and counts as evidence. The
   browser transcribes your speech: on this device when it can, otherwise with
   its speech service (Chrome sends the audio to Google). Replies use your
   computer's built-in voices. Run tests with **Run visible tests** (each run is recorded as
   evidence) or with `pytest` in your terminal.
5. Write your plan, assumptions, patch review, and final explanation in the
   dashboard. Optionally paste your Claude Code conversation into
   **Transcript**: `/export` in Claude Code copies it. Then press **Submit**.

Keep the two roles apart:
- **The coding assistant** (Claude Code) sees only the workspace. The workspace
  `CLAUDE.md` tells it to stay out of the interviewer materials, to avoid
  unsolicited complete solutions, to explain its assumptions, and to show a
  diff and wait for your approval before editing. You can still ask it for
  substantial code. `.claude/settings.json` also denies its Read and Edit tools
  access to the lab's folders.
- **The interviewer** is the dashboard. It answers clarification questions
  offline from the answer key, reveals the change at minute 30, and grades your
  session. To have Claude play the interviewer instead, use **Copy interviewer
  prompt** and paste it into a separate Claude conversation, not the coding
  assistant's. After you submit, **Copy grading prompt** gives a second
  conversation everything it needs to grade you: rubric, guide, test results,
  diff, notes, and transcript.

Claude Code usage counts toward your Claude subscription's limits. The lab never
reads, stores, or proxies your Claude login, and it doesn't measure that usage.

## Session flow (60 minutes)

| Minutes | Phase |
|---|---|
| 0–5 | Read the task and clarify requirements |
| 5–15 | Explore the repository and explain a plan |
| 15–40 | Implement with AI assistance and run tests |
| 30 | The requirement change appears in the dashboard and in `CHANGE_REQUEST.md` |
| 40–50 | Check edge cases and review the AI patch (`patch_review/`) |
| 50–60 | Explain your implementation and tradeoffs |

- **Pause** stops the clock. Paused time doesn't count toward minute 30.
- **Restart** starts a new timer, with or without resetting the workspace.
- **Reset workspace** restores every starter file. Anything you changed or
  added is moved to `.practice-backup/<time>/` inside the workspace, never
  deleted. Files outside the workspace are never touched, and the lab refuses
  to reset a folder that isn't one of its workspaces.

## Assessment

When you submit, the lab:
- Runs the original visible tests and the hidden grading tests against your
  code, on the original example data.
- Runs your own tests, and runs your new tests against the untouched starter to
  see which ones catch real bugs.
- Diffs your workspace against the starter.

It scores eight areas from 1 to 5:
- Problem understanding
- Repository exploration
- Quality of AI instructions
- Verification of AI output
- Correctness and edge cases
- Testing
- Code quality
- Communication and tradeoffs

Every score lists its evidence. An area with no evidence (for example, AI
instructions without a transcript) is marked **not observed**. How much you used
the assistant is never scored, only how well you directed and checked it.

The report also lists:
- Missed cases
- Questionable assumptions
- Three concrete improvements
- A short follow-up exercise for your weakest observed skill

It is saved in `~/interview-practice/.lab/submissions/`, along with the diff and
the grading prompt.

The automatic scores are heuristics. Use the grading prompt with a separate
Claude conversation, or a human, for a second opinion.

## Hidden materials are separated, not secret

The interviewer materials live in `practice/interviews/<id>/interviewer/`:
- the guide and its answers
- the reference solution
- the grading tests and rubric
- the change request

None of it is copied into your workspace until it is due: the change request at
minute 30, and the answers in your report after you submit. That separation is
for honest practice only. Anyone with access to this repository, including a
coding assistant that ignores its instructions, can read these files. Don't look
if you want the practice to count.

## Optional: API mode (billed per token)

API mode is off by default, and everything above works without it. With it on,
the dashboard can:
- answer clarification questions with a model
- write narrative feedback after you submit, through the official Anthropic
  Messages API

This is billed per token to an API account, separately from any Claude
subscription.

```sh
export ANTHROPIC_API_KEY=sk-ant-...         # read only by the local server; never sent to the browser
PRACTICE_API_MODE=on python3 practice/lab.py serve
```

Optional limits:
- `PRACTICE_API_MODEL` (default `claude-haiku-5-5`)
- `PRACTICE_API_MAX_OUTPUT_TOKENS` (default 700 per request)
- `PRACTICE_API_MAX_REQUESTS` (default 20 per session)

The dashboard badge shows when API mode is on, plus each session's requests and
input and output tokens. Totals are in `~/interview-practice/.lab/api_usage.json`.

If something goes wrong, the dashboard tells you and falls back to the offline
interviewer:
- a missing key
- a rejected key
- a rate limit (with the retry time)
- used-up credits
- the API being overloaded
- the session's request cap

**API credits:** API usage needs credits in the
[Claude Console](https://console.anthropic.com), under Billing. Some Claude plans
have included or offered API credits. If yours does, claim them from the offer on
your claude.ai account or in the Console's Billing page. Otherwise, buy credits
there. A Claude subscription is not an API key. Don't extract tokens from Claude
apps or proxy them; the lab never does.

## Layout

```
practice/
  lab.py                    command line (setup, serve, list, start, reset, submit, verify)
  interview_lab/            dashboard server, sessions, workspaces, grading, API mode, self-check
  interviews/<id>/
    interview.json          title, timing, source files, follow-up exercises
    starter/                becomes your workspace (task README, code, visible tests, patch_review/)
    interviewer/            guide, clarification answers, change request, rubric, grading tests, solution
  tests/                    unit tests for the lab
```
