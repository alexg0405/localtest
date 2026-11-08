# Interviewer guide: Palantir FDSE learning interview

Spoilers: this file has the answers. Keep it out of the candidate's workspace.

## What this round simulates

The Learning round of a Palantir Forward Deployed Software Engineer onsite,
in 45 minutes: up to ten to read an unfamiliar library's documentation, then
about 35 to extend code with it in a few short stages. It tests how fast someone
gets from unfamiliar to productive. Interviewers watch for:
- reading the docs before coding, and treating them as the map
- saying their mental model out loud, so it can be corrected early
- a few purposeful questions, not a stream of low-level ones, and none they
  could answer by reading
- building in small steps and testing each one
- honesty: "I'm not sure, let me check" beats a confident wrong answer

The library, relay, is made up, so nobody can know it in advance.

## The material

The customer is a six-hospital network. supplysync pulls each hospital's
inventory, page by page, and reports items below par. relay is a job library
with five ideas the candidate has to learn from DOCS.md:
- **Runner and handles.** `submit` returns a Handle; `result()` waits. Leaving
  the `with` block cancels jobs that are still queued (the classic trap:
  reading results after the block).
- **JobFailed.** `result()` raises `JobFailed` with the job's exception in
  `.cause`, never the original type.
- **Keys.** Same key: one at a time, in order. `limit(key, n)` raises it.
- **gather.** Outcomes in finishing order, with `outcome.error` unwrapped;
  never raises; a timeout cancels the rest.
- **Retries and cancellation.** `Retry(times=2)` is three tries. Running jobs
  can't be interrupted; they check `relay.cancelled()`.

## Questions to check understanding

Reading time is only ten minutes, so mostly let them read. Ask one of these
when they explain what they've read, or as they start to use the part it
covers, one at a time. Don't give the answer: if they're wrong, ask them to
look at the section again.
- What happens to a job that's still queued when the `with` block ends? (It's cancelled and never runs.)
- If a job raises ValueError, what does `handle.result()` raise? (JobFailed, with the ValueError in .cause.)
- You submit three jobs with the same key to a runner with four workers. How many run at once? (One.)
- With `Retry(times=2)`, how many times can the function run? (Three.)
- What order does `gather` return outcomes in? (The order the jobs finished.)
- How does a running job find out it's been cancelled? (It checks relay.cancelled().)
- What does `pull_all` do today, and why is it slow? (One hospital after another, one page after another, each request waiting on the network.)

## The parts

**Part 1, parallel.** One job per hospital that runs `pull_hospital`
(pages in order inside the job, so a hospital never gets two requests at
once), on `Runner(workers=4)`, waiting inside the block. Per-page jobs work
too, with `key=hospital_id`. Traps: reading results after the block; per-page
jobs without a key (TooManyRequests).

**Part 2, failures.** `retry=relay.Retry(times=2, on=(TransientError,))`.
HospitalOffline isn't retried because it isn't in `on`. Then sort hospitals by
outcome: with `gather`, `outcome.error` is the raw exception; with `result()`,
catch `JobFailed` and look at `.cause`. Anything else should re-raise: ask
whether they asked about other errors. Traps: `times=3`; `except
HospitalOffline` around `result()`; swallowing every error into `missing`.

**Part 3, deadline.** `relay.gather(handles, timeout=deadline)` cancels what's
unfinished: queued jobs are dropped, running ones are asked to stop. Cancelled
outcomes are late. `pull_hospital` must check `relay.cancelled()` before each
page, or the late hospital keeps getting requests and the `with` block waits
for it. Traps: no cooperative check; keeping partial pages.

**Part 4, progress (stretch).** `runner.on_finish` with a `relay.Tally`
(or a lock), skipping cancelled jobs. It runs on worker threads while the sync
runs. Trap: calling `on_progress` after `gather` returns, all at once.

## Follow-up questions to ask

Only if the parts end with time to spare. When the 45 minutes are up, stop.

- What surprised you about relay, compared with what you expected from a thread pool? (the with block cancelling queued jobs, JobFailed wrapping, finishing order)
- Where did the docs leave you unsure, and how did you resolve it?
- What would you change about relay if you owned it?
- If the hospital network doubled to twelve hospitals, what would you change in the sync? (workers, the VPN limit, keys)
- How would you know, the next morning, that last night's sync went wrong?

## Signals

Green: reads sections before using them; explains keys and the with-block
behavior back correctly; asks about the one real ambiguity (other errors);
runs the tests after each change; says "I'm not sure" and checks the docs.
Red: starts coding in the first minute or two; guesses at relay's behavior
from other libraries; catches the wrong exception type and doesn't notice; asks
questions the docs answer in the first paragraph; claims understanding that
the code contradicts.
