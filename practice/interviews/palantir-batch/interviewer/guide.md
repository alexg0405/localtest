# Interviewer guide: Palantir FDSE learning interview (batch processor)

Spoilers: this file has the answers and the planted bugs. Keep it out of the candidate's workspace.

## What this round simulates

The Learning round of a Palantir Forward Deployed Software Engineer onsite,
in its "use and debug a batch data processor" form, in 45 minutes: up to ten
to read an unfamiliar library's docs and a customer's job built on it, then
about 35 to add to that job and chase down bugs the customer reported. It
tests how fast someone gets from unfamiliar to useful, and whether they
debug from evidence. Interviewers watch for:
- reading the docs before coding, and going back to them when a symptom
  doesn't make sense
- saying their mental model out loud, so it can be corrected early
- reproducing a bug before fixing it, and checking the fix against the
  reproduction
- a few purposeful questions, not ones the docs answer
- honesty: "I'm not sure, let me check" beats a confident wrong answer

The library, sluice, is made up, so nobody can know it in advance.

## The material

The customer is a regional electric utility. meterbill's nightly job turns
the day's 15-minute smart-meter readings into a daily_usage row per account
(daily_usage pipeline), then prices those rows into the charges table that
billing bills from (charges pipeline). The starter's own tests pass: they
use three small accounts, one batch, one run. Three bugs are planted, and
each is a sluice behavior the candidate has to learn from DOCS.md:
- **Lazy pipelines and batches.** Nothing runs until `run()`; records go
  through every step a batch at a time (500 in the job).
- **Per-batch aggregates (section 4).** `aggregate` defaults to
  `scope="batch"`. The job's `total` step is per batch, and its sink upserts
  by (account, day), so an account whose readings span batches keeps only its
  last batch's part. On the sample night, C-200 shows about 103 kWh instead
  of about 2,055, and C-201 is short too. The run report gives it away: the
  total step puts out 14 records for 11 accounts, and the sink "wrote 14
  rows" into an 11-row table.
- **Append vs upsert (section 5).** The charges sink uses the default
  `append`, so re-running a night adds a second charge per account.
  `replace` empties the whole table.
- **Error policies and failed runs (section 6).** The parse step has the
  default `on_error="fail"`, so one bad reading raises `RunFailed`. Batches
  already written stay written, and the charges pipeline never runs.
- **Read-only records (section 3).** Not planted, but candidates hit it in
  their own steps (`record["day"] = day` raises TypeError, which then follows
  the step's `on_error`).

## Questions to check understanding

Reading time is only ten minutes, so mostly let them read. Ask one of these
when they explain what they've read, or as they start to use the part it
covers, one at a time. Don't give the answer: if they're wrong, ask them to
look at the section again.
- You build a pipeline with three steps and don't call `run()`. What has happened? (Nothing: pipelines are lazy.)
- With `batch_size=500` and 1,200 records, how many records does an aggregate see at once by default? (One batch: 500, 500, then 200.)
- One store's orders are spread over three batches, and you aggregate by store. How many records come out? (Three with the default scope, one with scope="run".)
- What happens if a map step does `record["x"] = 1`? (TypeError, which the step's on_error then handles: by default the run fails.)
- You run a pipeline that sinks with the default mode twice. What's in the table? (Every row twice.)
- What's the difference between `on_error="skip"` and `"dead_letter"`? (Both drop the record; dead_letter keeps it and its error in report.dead_letters.)
- A run fails in its third batch. What's in the sink's table? (The first two batches' rows, unless a scope="run" aggregate came before the sink.)
- What does the job do each night, and what does billing read? (Usage per account into daily_usage, then charges from it; billing adds up every charges row.)

## The parts

**Part 1, meter gaps (use).** A new pipeline: aggregate by
`("meter", "account")` with `readings=sluice.Count()`, filter
`readings < 96`, map in `day` and `missing` as a new dict, sink to
`meter_gaps`, and add its report to `run_nightly`. Count raw readings: don't
reuse `parse_reading`, since a reading that won't parse still counts (the
open question, if they ask). Traps: mutating the record in the map
(TypeError); the default per-batch scope, which flags healthy meters that
straddle a batch boundary (the example passes because it's one batch; one
part 3 grading test checks it at batch_size=50); appending, so a re-run
lists meters twice (worth a follow-up question).

**Part 2, billed twice (debug).** Root cause: the charges sink appends, so a
re-run adds a second set of charges, and billing adds up every row. The usage
pages look fine because daily_usage already upserts. Fix:
`mode="upsert", key=("account", "day")`. Good candidates reproduce it first
(run twice, print the charges table) and spot the contrast with the
daily_usage sink. Traps: `key="account"`, so Tuesday's charge replaces
Monday's; `mode="replace"`, which wipes every other day's charges; clearing
the table by hand.

**Part 3, under-billed big accounts (debug).** Root cause: the `total`
aggregate is per batch, so C-200 (readings 474 to 1029) comes out three
times, and the upsert keeps only the last batch's part. Homes fit inside one
batch, which is why they look right. Fix: `scope="run"` on the aggregate,
and on their meter_gaps aggregate too ("check whether anything else has the
same problem"). Good candidates print the run report and notice 14 records
out of the total step for 11 accounts. Traps: raising BATCH_SIZE (the
grading tests pass their own batch sizes, so it doesn't hold); switching the
sink to append (two rows per account, and the usage page reads the first);
summing rows in billing.py, which isn't theirs to change.

**Part 4, one bad reading (stretch, debug and harden).** Root cause: the
parse step's default `on_error="fail"`, so `ERR` raises `RunFailed`, the
batches before it stay written, and charges never run. Fix:
`on_error="dead_letter"` on parse only, then write each of
`report.dead_letters` to `bad_readings` (meter, account, ts, raw wh,
`str(error)`), upserted by `(meter, ts)` so a re-run lists it once. Traps:
`"skip"`, which loses the reading; dead-lettering every step, which would
hide real bugs; reading `letter.record["wh"]` when the field is missing;
appending bad_readings.

## Follow-up questions to ask

Only if the parts end with time to spare. When the 45 minutes are up, stop.

- What surprised you about sluice, compared with what you expected from a batch tool? (per-batch aggregates by default, append by default, a failed run keeping earlier batches)
- Where did the docs leave you unsure, and how did you resolve it?
- What would you change about sluice if you owned it?
- Is your meter_gaps pipeline safe to re-run? How would you know? (only with upsert; append lists every meter again)
- How would you notice, the next morning, that last night's run went wrong? (compare the report's counts to the night before, alert on dead letters, reconcile against the meters' totals)

## Signals

Green: reads sections before using them; explains per-batch aggregation and
the sink modes back correctly; reproduces each bug before touching code;
uses the run report to see where records went; asks about the real
ambiguities (bad readings in meter_gaps, billing an account with a bad
reading); runs the tests after each change; says "I'm not sure" and checks.
Red: starts coding in the first minute or two; changes code before
reproducing a bug; "fixes" part 3 by raising the batch size; reaches for
skip and loses readings; guesses at sluice's behavior from other tools;
claims understanding that the code contradicts.
