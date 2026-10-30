# Interview Lab

Timed, local practice for AI-assisted software engineering interviews at the
internship, new-grad, and junior level, in Python with pytest. You work in a
normal editor with Claude Code as your coding assistant. A local dashboard runs
the 60-minute clock, plays the interviewer, reveals a requirement change at
minute 30, and grades your session from evidence when you submit.

It needs only Python 3.9+ and pytest: no cloud services, no database, and no API
key. It runs on macOS, Linux, and Windows.

## The interviews

| ID | Scenario | What it practices |
|---|---|---|
| `commerce-orders` | An order service with double charges, a missing order in the history, and no cancel. Inspired by high-volume commerce teams such as Amazon. | Idempotency, partial-failure rollback, retries, pagination |
| `banking-ledger` | A batch ledger over a synthetic transaction feed. Balances are off by a cent, events are applied twice, and bad events slip through. Inspired by banking teams such as Capital One. | Integer-cent money, duplicate events, validation, UTC reporting |
| `unfamiliar-repo` | You're on call for a nightly import in a codebase nobody on the team wrote, and the job has started failing. | Diagnosis, a focused fix, regression tests, reviewing an AI patch |
| `amazon-full-loop` | The full Amazon SDE intern interview (60 min, no AI): a deep dive on a project from your résumé, two Leadership Principles questions, then "top late carriers" with a streaming follow-up, coded and run in the browser editor. | Explaining your own work, STAR stories, hash maps and heaps, complexity, testing |
| `amazon-final-1` | Amazon SDE intern final round 1 (60 min, no AI): two Leadership Principles questions with follow-ups, then "top late carriers" with a streaming follow-up, coded and run in the browser editor. | STAR stories, hash maps and heaps, complexity, testing |
| `amazon-final-2` | Amazon SDE intern final round 2 (60 min, no AI): two different Leadership Principles, then a warehouse-robot shortest path with a "clear k shelves" follow-up. | STAR stories, BFS, state search, complexity, testing |
| `amazon-coding` | Amazon coding round (45 min, no AI): just coding. "Price-drop alerts": the interviewer asks for your approach and its complexity, pushes you past a brute-force solution, gives a hint when you're stuck, then adds a streaming follow-up. | Complexity, optimizing past brute force, monotonic stacks, follow-ups, thinking aloud |
| `amazon-behavioral` | Amazon behavioral round (45 min): four Leadership Principles per session from a bank covering all 16, with three follow-ups each. | STAR, ownership, measurable impact, follow-ups, self-awareness |
| `resume-deep-dive` | Résumé deep dive (30 min): Claude plays an Amazon engineer interviewing you for the SDE internship, who reads your résumé, has you walk through your background, goes deep on two of your projects or roles, asks two Leadership Principles questions in their own section, then takes your questions. | Explaining what you built, decisions and tradeoffs, ownership, follow-ups, STAR stories |
| `palantir-learning` | Palantir FDSE Learning round (30 min, no AI): five minutes to learn relay, a job library you've never seen, from its docs, then 25 to extend a hospital network's nightly supply sync with it in up to four parts: parallel pulls, flaky and offline hospitals, a deadline, and live progress. | Reading docs fast, purposeful questions, threads and cancellation, small tested steps, honesty |

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

On Windows, where Python usually has no `python3` command, use `py` instead
(`py practice\lab.py setup`), or `npm run practice -- setup`, which finds Python
for you on any system. The dashboard shows PowerShell versions of its commands.

If you run Roomside, you do not need a second command: `npm start` also starts Interview Lab and serves it at http://127.0.0.1:5173/practice/. Roomside's **Practice** button opens it in its own tab, and the lab's **Roomside** link switches back. `npm run practice` (or `serve`) runs the lab on its own at http://127.0.0.1:8765/. Check the lab itself:

```sh
python3 practice/lab.py verify                                        # end-to-end self-check of all three interviews
~/interview-practice/.venv/bin/python -m pytest practice/tests -q      # unit tests (Windows: ~\interview-practice\.venv\Scripts\python.exe)
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
   its speech service (Chrome sends the audio to Google). Everything the
   interviewer says is read aloud, with or without the mic, in the most natural
   voice your browser has; the speaker button in the chat window (or **Read
   aloud** in the Interviewer tab) mutes it. See [The interviewer's voice](#the-interviewers-voice)
   to pick another. Run tests with **Run visible tests** (each run is recorded as
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

## Problem practice

The lobby's **Problem practice** section has 15 classic interview problems:
LRU Cache (#146), Number of Islands (#200), Reorganize String (#767), Two Sum
(#1), Longest Substring Without Repeating Characters (#3), Longest Palindromic
Substring (#5), Koko Eating Bananas (#875), Merge Intervals (#56), Group
Anagrams (#49), Subarray Sum Equals K (#560), Rotting Oranges (#994), Course
Schedule II (#210), Search in Rotated Sorted Array (#33), Lowest Common
Ancestor of a Binary Tree (#236), and Meeting Rooms II (#253).

Each one is a 35-minute session with the live interviewer (voice or chat):
- **0–3 min:** clarify the problem.
- **3–8 min:** explain your approach.
- **8–28 min:** code it in the browser editor, with Run tests and Custom input.
- **28–35 min:** walk through your code and answer follow-ups.

Each problem has its own examples, hidden tests (including speed tests that
catch brute-force solutions), clarification answers, three hints, a reference
approach, and follow-up questions. The statements and examples are written for
this lab; each links to LeetCode's official version.

**Practice out loud.** The mic button next to the timer (or ⌥M on a Mac, Alt+M on Windows, even inside
the editor) turns on listening.
- The button shows a live caption of what it hears.
- The coach responds to your train of thought when you pause, and answers
  spoken questions right away.
- Lab remembers the mic setting for your next session, and the first time,
  the chat window invites you to turn it on.

Pick a mode before you start, or switch at any time in the interview's top
bar:
- **Real interviewer:** answers only questions about the problem. A hint is a
  short nudge that lowers your problem-solving score. Nothing is explained
  until you submit.
- **Coach:** a friendly tutor that helps you learn.
  - Ask for a hint any time (the Hint button, or just say "can I get a hint?").
    Hints get stronger only after you've made progress (said, typed, ran, or
    edited something). Asking again right away gets the same idea rephrased,
    and that isn't counted.
  - Ask about concepts ("what's a heap?", "how does binary search work?").
  - It praises good clarifying questions.
  - After every test run, it tells you what failed and what to try, or which
    edge cases to check next.
  - It checks in if you go quiet for two minutes while coding.
  - It can show the full approach from the menu. That caps your
    problem-solving score at 3.

  Hints in coach mode are noted but not penalized.

**Conversational interviewer and coach (your Claude subscription).** While
Roomside is running (`npm start`), both modes talk with Claude through
Roomside's Claude Code bridge. That's the official Claude Code CLI on your computer, signed in with
your Claude account: no API key, and nothing is taken from the app.
- **What Claude sees:** the problem, your current code, your latest test
  results, and the conversation. It also gets the clarification facts, the
  hint ladder, and the reference approach as private context.
- **As the coach:** Socratic, one question at a time, about your actual code
  and failing tests. It doesn't hand over the solution unless you give up and
  ask for it.
- **As the real interviewer:** polite and neutral. It answers clarifying
  questions, probes your complexity, edge cases, and tradeoffs, and won't
  confirm your approach or point out bugs. It gives one-sentence hints only
  when asked, and those count against you. It lets you code in peace, asks you
  to talk it through after a long silence, and asks the follow-up questions at
  the end.
- **When it speaks:** when you type, ask a question out loud, or ask for a
  hint; after a pause when you think out loud (the real interviewer only while
  you plan or wrap up); after test runs (coach only); and when you've been
  quiet for a while.
- **How replies appear:** they stream into a chat window with the whole
  conversation and a reply field, and are read aloud sentence by sentence,
  even with the mic off.
  - The speaker button in the window's title bar mutes and unmutes reading.
    Lab remembers the setting; it starts on.
  - Drag the window by its title bar, and resize it from any edge or corner.
  - Minimize it to a title bar that shows the latest reply (or double-click
    the title bar), or close it.
  - The chat button next to the timer reopens it. A dot on that button means
    there's a reply you haven't seen.
  - Lab remembers where you put the window, its size, and whether it's open.
    On a narrow screen it sits at the bottom.
- **Settings and fallback:** the model is Claude Sonnet 5.5 by default (set
  `PRACTICE_COACH_MODEL` to change it), and usage counts toward your plan. If
  Roomside or Claude Code isn't available, the scripted coach answers instead.

Problems are graded on six areas:
- problem understanding
- problem solving and complexity
- correctness, edge cases, and performance
- testing and verification
- code quality
- communication

Every report ends with **How to solve it**. The lobby tile shows your last
score and which mode you used.

## Résumé deep dive

A 30-minute conversation about your own résumé with an Amazon engineer
interviewing you for the SDE internship, played by Claude on your subscription
(through Roomside, like the conversational coach).

- **Your résumé:** pick **Résumé deep dive with an Amazon engineer**, then
  **Upload your résumé** (PDF, Word .docx, or text), or drop the file on the
  panel. **Paste or edit** shows the text that was read, so you can fix it or
  paste it instead. Only the text is saved, in
  `~/interview-practice/.lab/resume.json`; **Remove** deletes it. Reading PDF
  and Word files uses Roomside's reader, so open the lab through Roomside
  (`npm start`); on its own it takes text files and pasted text. The Amazon
  rounds use the same résumé, and so does the panel at the bottom of the
  Problem tab during an interview, where you can add or change it mid-session.
- **The interview:**

  | Minutes | What happens |
  |---|---|
  | 0–3 | The interviewer introduces themselves; you walk through your background. |
  | 3–12 | A deep dive into your strongest project or role. |
  | 12–19 | A deep dive into a second experience, especially claims you haven't explained yet. |
  | 19–27 | **Leadership Principles**, its own section: two behavioral questions with follow-ups. |
  | 27–30 | Your questions for the interviewer, then the close. |

  The interviewer names things from your résumé and asks one short question at
  a time, pitched at intern level: which part you built, how it works step by
  step, why you chose it over a simpler option (it pushes back once), a what-if
  or two about your own system (ten times the users, a crash halfway), the
  hardest bug, where your numbers came from, and who it helped. It keeps
  digging until you reach the edge of what you know, talks like a person
  rather than a script, and keeps the clock.
- **Leadership Principles section:** with your first answer after minute 18,
  the interviewer says it's switching to behavioral questions based on
  Amazon's Leadership Principles, and a divider marks the start of the section
  in the chat window and the Interviewer tab (the top bar shows it too). It
  asks two principles per session, from the ones most often asked of interns
  (Customer Obsession, Ownership, Learn and Be Curious, Have Backbone; Disagree
  and Commit, Deliver Results, Bias for Action, Earn Trust, Insist on the
  Highest Standards, Invent and Simplify, Are Right, A Lot), rotating with the
  Amazon rounds so repeat sessions get new ones. It doesn't name the principle.
  Each gets two or three follow-ups on your story (what you did, the result,
  what you learned), and an example that doesn't fit the principle gets
  "can you think of a time when…?"
- **Talking:** turn on the mic and answer out loud. Everything you say is your
  answer, and the interviewer waits until you **press Enter**, however long you
  pause to think (see [Answering out loud](#answering-out-loud)). You can also
  type in the chat window. Everything the interviewer says is read aloud, and
  your résumé is in the Problem tab for reference.
- **Without Claude** (Roomside not running), a scripted interviewer asks a
  fixed set of questions built from the roles and projects it finds in your
  résumé.
- **Grading:** six areas, scored from what you said: background walkthrough,
  technical depth, ownership and impact, handling follow-ups, Leadership
  Principles (each principle scored as its own STAR story, with a table in the
  report), and communication and questions. After you submit, the
  interviewer writes notes: an overall view, what came across well, what to
  work on (with your own words quoted), the résumé claims to be ready for, and
  an exercise. The notes are saved with the report as `interviewer_notes.md`.

## Answering out loud

In the behavioral round, the résumé deep dive, and the Leadership Principles
part of the Amazon rounds, what you say is your answer:
- Turn on the mic and answer. Your words add up in the chat window and the
  Interviewer tab, marked "press Enter when you're done", and nothing is sent
  while you pause to think.
- Press **Enter** to finish: anywhere on the page except while you type in a
  field or your notes, or with the send button when the reply field is empty.
  The interviewer replies then.
- Typing in a reply field sends what you typed, after anything you'd already
  said out loud.
- A quick question of your own ("Could you repeat that?", "Can it be a school
  project?") gets an answer and doesn't count as part of your story.
- The interviewer's timed lines wait for you: it won't start the questions at
  minute 2, or move to the next part of the interview, while you're mid-answer.

## The interviewer's voice

The interviewer reads aloud in the most natural voice your browser has:
Premium or Enhanced voices on a Mac if you've downloaded one, Edge's Natural
voices on Windows, or Chrome's Google voices. The Google voices are spoken by
Google's servers, so they need a connection; if one can't be reached, the lab
switches to the best voice on your computer. To choose another, open the **…**
menu and pick **Interviewer's voice…**, which plays a sample; the lab
remembers your choice. For the most natural voice on a Mac, download one in
System Settings → Accessibility → Spoken Content → System voice → Manage
Voices (for example Ava or Zoe, Premium), then reload the page.

## Amazon final-round mode

The two `amazon-final` rounds simulate the final round Amazon SDE intern
candidates describe for the Summer 2026 and Winter 2027 cycles. That's usually
two back-to-back 45–60 minute rounds. Each round has 15–30 minutes of Leadership
Principles questions with probing follow-ups, then one business-framed coding
problem at about LeetCode-medium difficulty in a plain shared editor, where you
explain your approach, give the complexity, and dry-run your code by hand.
The lab's two rounds run 60 minutes each:

| Minutes | What happens |
|---|---|
| 0–3 | Introductions: press Enter after "tell me about yourself" and the questions start. |
| 3–20 | Two Leadership Principles questions with follow-ups. |
| 20–25 | Read the coding problem and ask clarifying questions. |
| 25–50 | Code it and talk it through. The follow-up comes at minute 42, or as soon as your tests pass. |
| 50–60 | Dry-run your code, give the complexity, and ask your questions. |

**The interviewer keeps the clock**, the way a real one does:
- The top bar shows the part you're in and the time left in it (amber in the last two minutes).
- If a story runs past its share of the questions' time, the interviewer skips its remaining follow-ups
  ("In the interest of time, let's move on") so both questions fit. The last question keeps its
  follow-ups until minute 20.
- Finish a part early and the interviewer moves on. The coding problem comes as soon as the questions
  run out. Reading the problem keeps its five minutes, and the coding part gets the time you saved
  ("We have about 31 minutes for coding"). Start typing while you read, and the coding part starts
  then.
- While you code, it gives a time check with 10 and 5 minutes left.
- **Done coding** (top bar) tells the interviewer you're done. The follow-up comes next if it hasn't
  yet; after it, you go straight to the dry run and your questions.
- The report has a **Time** section: how long each part took against the plan, how long you spent
  coding, how long each story ran, and notes on your pacing (for example, how long you took to start
  coding after the problem appeared).

These rounds differ from the other three:
- **No AI.** Amazon asks candidates not to use GenAI tools in interviews unless
  explicitly permitted. The workspace's `CLAUDE.md` tells Claude Code not to
  help, and the AI areas aren't scored.
- **A real code editor in the browser.** The solution file opens in the first
  editor tab, with Python highlighting, line numbers, and bracket matching. It
  saves to your workspace as you type and stays in sync if you also edit the
  file in VS Code.
  - **Run tests** (or ⌘/Ctrl+Enter) runs the example tests.
  - The **Custom input** console runs any Python you write against your code,
    with a 10-second limit.
  - Every run counts as evidence. Grading still runs hidden tests, including
    large-input performance tests, after you submit.
- **Leadership Principles tailored to Amazon.** The question bank
  (`interviews/_amazon/leadership_principles.json`) covers all 16 principles,
  with two original questions each and three follow-ups per question.
  - Each session picks different principles, preferring questions you haven't
    been asked recently, so repeat sessions rotate through the bank.
  - Round 1 draws from Customer Obsession, Ownership, Deliver Results, Bias for
    Action, Insist on the Highest Standards, Invent and Simplify, and
    Frugality.
  - Round 2 draws from Earn Trust, Have Backbone; Disagree and Commit, Dive
    Deep, Learn and Be Curious, Are Right, A Lot, Hire and Develop the Best,
    and Think Big.
  - The behavioral round draws from all 16.
  - The interviewer asks out loud. Whatever you say or type is your answer,
    and when you press Enter it digs in with the next follow-up (see
    [Answering out loud](#answering-out-loud)). In the behavioral round your
    introduction gets a reply too: press Enter after "tell me about yourself"
    and the questions start, even before minute 2. Finish all four early and
    the interviewer moves on to your questions.
  - While Roomside is running, Claude puts each question and follow-up in its
    own words: it reacts to what you actually said, picks the follow-up you
    haven't answered yet, and, if you've added your résumé, may suggest an
    experience from it as an example. The questions and the order of
    follow-ups still come from the bank, so grading is the same. Without
    Claude, the scripted interviewer asks them as written.
- **Graded on everything.** The coding rounds score seven areas:
  - problem understanding
  - Leadership Principles, scored story by story
  - problem solving and complexity
  - correctness, edge cases, and performance
  - testing and verification (your test runs, custom runs, tests you wrote, and
    dry runs)
  - code quality
  - communication (thinking aloud and your questions at the end)

  The behavioral round scores six areas: Leadership Principles, STAR structure,
  ownership and measurable impact, handling follow-ups, self-awareness, and
  communication and pacing.

  Each story is checked for:
  - STAR
  - "I" versus "we"
  - a number in the result
  - reflection
  - whether it shows the principle that was asked about
  - length (about 2–3 minutes)
  - whether each follow-up answer adds new detail

  Reusing one story for several principles is marked down, as an interviewer
  would. The report includes a table with one row per principle.
- **A follow-up at minute 42** in the coding rounds (or as soon as your tests
  pass), instead of a requirement change.

The flow is modeled on candidate reports, not official Amazon material, and
every loop differs. The questions are original. Sources:
- [Amazon 2026 SDE intern virtual onsite write-up](https://dev.to/net_programhelp_e160eef28/amazon-2026-sde-intern-vo-interview-experience-two-technical-rounds-breakdown-11da)
- [Amazon SDE intern 2026 interview experiences on takeUforward](https://takeuforward.org/community/interview-experiences/amazon-sde-intern-interview-experience-2026-hackon-6-month-internship-selected)
- [Glassdoor: Amazon SDE intern interviews](https://www.glassdoor.com/Interview/Amazon-Software-Development-Engineer-Intern-Interview-Questions-EI_IE6036.0,6_KO7,43.htm)
- [IT Pro on Amazon's GenAI interview policy](https://itpro.com/business/careers-and-training/amazon-bans-ai-tools-during-job-interviews)

## Amazon coding round

`amazon-coding` is a 45-minute Amazon technical interview that's only coding,
like a phone screen or a coding-only loop round. It has one problem, a
LeetCode medium framed as a business task ("price-drop alerts"), then a
follow-up, then questions. There are no Leadership Principles questions.

| Minutes | What happens |
|---|---|
| 0–8 | Read the problem and clarify. Then, before you code, give the interviewer your approach and its complexity. |
| 8–35 | Code it and talk it through, with time checks at 10 and 5 minutes left. |
| 35–45 | Trace the example, give the complexity, answer the interviewer's follow-up questions, and ask yours. |

The interviewer behaves the way Amazon interviewers do:
- **It wants the complexity, and then better.**
  - Before you code, it asks for your approach and its time and space
    complexity. If your idea is slower than it needs to be, it asks once
    whether you can do better. Starting with brute force is fine.
  - When your tests pass, it checks behind the scenes whether your solution is
    fast enough. If it's quadratic, it asks for the complexity, then pushes for
    a faster version without naming the technique. If it's already fast, it
    doesn't ask.
- **Hints when you're stuck.**
  - Say you're stuck, or press **Hint**, at any time.
  - If you go quiet for two and a half minutes (nothing typed, said, or run),
    it checks in. If you're still stuck a little after that, once you've
    started coding, it gives a small hint. Bigger hints come only after you've
    made progress.
  - If the same tests keep failing for a few minutes, it suggests tracing the
    smallest failing input by hand, without saying what's wrong.
  - When it asks "Want a hint?", a yes takes it.
  - Each hint after the first lowers your problem-solving score a little.
- **Follow-ups, Amazon style.**
  - As soon as your solution passes and is fast, it extends the problem: the
    prices now stream in, and `PriceWatch.add` has to report each day as soon
    as it gets cheaper.
  - Its example lands in your tests. It has its own hints, and its own check:
    "What does one call to add cost?"
  - If your first version works but stays slow, the follow-up comes at minute
    26 anyway, or four minutes after the interviewer asked for better,
    whichever is later. If nothing works yet, it waits. With less than four
    minutes of coding left, it skips the follow-up and goes to the wrap-up.
  - In the wrap-up it asks follow-up questions one at a time: the amortized
    cost, the worst single call, memory, millions of items, and tests.
- **It questions your choices as you code**, like the final rounds'
  interviewer. It never points out bugs, gives the fix, or confirms you're
  optimal.
- **Done coding** tells it you're done. It looks at your code first: it asks
  for a faster version, or for you to test it if it doesn't work yet, then
  gives the follow-up or moves on to the wrap-up.

With Claude (Roomside running), the interviewer says all of this in its own
words, about your code. Without Claude, the scripted interviewer says it in
fixed words.

The report scores six areas: problem understanding, problem solving and
complexity, correctness and edge cases, testing and dry run, code quality, and
communication. It also has:
- **How the interviewer helped:** every hint (and whether you asked for it or
  were stuck), check-in, nudge, and push for a faster version, with its minute.
- **Time:** your approach, the first version, making it faster, the follow-up,
  and the wrap-up, each against the plan.
- **How to solve it**, from the interviewer's guide.

## Palantir FDSE learning round

`palantir-learning` simulates the Learning round of a Palantir Forward
Deployed Software Engineer onsite, for a commercial team. It's 30 minutes:
about five to read an unfamiliar library's docs, then 25 to extend code with
it in a few short stages. It tests how fast you get from unfamiliar to
productive, not what you already know. The library here, relay, is made up,
so nobody knows it in advance.

| Minutes | What happens |
|---|---|
| 0–5 | Read relay's docs (the **Docs** tab) and the customer's sync tool (the editor), and ask anything. Press **Ready for the task**, or say "I'm ready". |
| 5–30 | Extend the sync in up to four parts. Each part shows up in the **Tasks** tab with an example test, and comes as soon as the last one's tests pass. **Next part** moves on without finishing. At 30 minutes, the interviewer calls time. |
| If time's left | When the parts end early (every part done, or too little time for another): what surprised you about relay, what you'd change, and your questions. |

**The customer and the library.** A six-hospital network's nightly sync pulls
every hospital's supply inventory, page by page, and reports items below
par. It's slow, and the hospitals' systems are old. relay runs jobs on worker
threads, with a few behaviors you only get right by reading:
- Leaving the `with` block cancels jobs that are still queued.
- `result()` raises `JobFailed` and puts the job's exception in `.cause`.
- Jobs with the same key run one at a time.
- `gather` returns outcomes in finishing order.
- `Retry(times=2)` means three tries.
- A running job only stops when it checks `relay.cancelled()`.

**The parts:**
1. Pull the hospitals in parallel: at most four requests at once, and one at
   a time per hospital.
2. Retry dropped connections, up to 3 tries, and report offline hospitals as
   missing.
3. A deadline: late hospitals are reported, and they stop getting requests.
4. A stretch: live progress from callbacks on worker threads.

Hidden grading tests also check the traps the docs warn about.

**The interviewer** plays an engineer on the deployment, friendly and
collaborative:
- While you read, it mostly lets you read. When you explain what you've read,
  it checks your model with questions like "What happens to a job that's
  still queued when the block ends?" When you're wrong, it sends you back to
  the right section rather than correcting you.
- It answers honestly. When the docs cover the question, it says which
  section. When they don't, it answers from the facts, such as what to do
  with errors the task doesn't mention. That's the one real ambiguity worth
  asking about.
- Before each part, it asks how you'd do it. While you code, it asks what the
  relay calls you write return, raise, or when they run.
- When you're stuck on a part, it checks in, then points you to the docs with
  the part's hints. It helps the same way as in the coding round, but it
  doesn't interrupt your reading.

**The report** scores six areas: reading and understanding (what you explain
about relay, while you read and as you use it), questions, applying the
library, pace through the parts (two parts in the 25 minutes is solid, three
is strong), code quality, and communication and honesty. It also has:
- the interviewer's written notes (Claude, on your subscription), which
  check what you said about relay against its docs
- how the interviewer helped
- the time each part took
- how to solve each part

It's modeled on candidate reports, not official Palantir material. Sources:
- [Palantir FDSE interview loop and rounds (LeonStaff)](https://leonstaff.com/blogs/palantir-interview-process-decomp-fdse-guide/)
- [Palantir FDSE decomposition round and the full loop (Vibe Engines)](https://vibeengines.com/handbook/fde-interview-palantir)
- [Palantir FDE interview guide (Aced)](https://www.aced.io/guides/palantir-forward-deployed-engineer-interview)
- [Glassdoor: Palantir Forward Deployed Software Engineer interviews](https://www.glassdoor.com/Interview/Palantir-Technologies-Forward-Deployed-Software-Engineer-Interview-Questions-EI_IE236375.0,21_KO22,56.htm)

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
