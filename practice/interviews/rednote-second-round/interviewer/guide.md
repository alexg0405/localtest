# Interviewer guide: RedNote second round

Spoilers: this file has the answers. Keep it out of the candidate's workspace.

## What this round simulates

A 60-minute second-round interview with an engineer from RedNote's New York
office, which RedNote opened in 2026 along with Palo Alto to build its first US
teams. The recruiter described the round as mostly behavioral, possibly with
coding. Candidate reports of Xiaohongshu (RedNote) interviews describe second
rounds that dig deep into one project from the résumé (what they built, the
hard parts, how they solved them) and include an easy-to-medium coding problem.
So this round is:
- About 30 minutes on experience: one project from the résumé in depth, then
  three behavioral questions with follow-ups.
- One short coding problem at about LeetCode-easy-to-medium difficulty, with a
  follow-up, in a plain shared editor.
- Time at the end for the candidate's questions.

There's no AI assistant; the editor runs code, and the runs count.

## Résumé deep dive

Minutes 3–32 open with one project or role from the candidate's résumé (the
first role listed, else the first project). Dig in at student level: what they
built themselves, how their part works step by step, why that choice over a
simpler option, what happens at ten times the users, the hardest bug, and how
they knew it worked. When an answer stays high-level, ask exactly how their part
works. Then switch to the behavioral questions.

## Behavioral questions

Each session picks three themes from this round's focus list and a question for
each from RedNote's bank (`interviews/_rednote/behavioral.json`), preferring
questions the candidate hasn't been asked recently. The themes are ones a new,
fast-moving US team working with colleagues in China would care about: building
for users, ownership when things are unclear, working across teams and time
zones, disagreement and feedback, learning fast, setbacks, moving fast, and
going beyond the task. They're common behavioral topics, not RedNote's official
values. Each question has three follow-ups. Look for:
- a specific situation (not "I usually…")
- the candidate's own actions ("I", not "we")
- a result with a number
- what they learned

When an answer is thin, push on "what did *you* do?" and "how did you know it
worked?".

## Coding problem

`longest_streak(days)`: the longest run of consecutive days with at least one
note. The days are unsorted and repeat when a creator posts several notes in a
day.

Good solutions:
- Sort the distinct days and count runs: O(n log n) time, O(n) space. A fine
  first answer; ask whether they can avoid the sort.
- A set of the days, and walk forward only from days whose previous day has no
  note: O(n) time and space, since each day is visited a constant number of
  times.

Ambiguities a strong candidate asks about (see `clarifications.json`): several
notes on one day, whether the days are sorted, an empty list, what counts as
consecutive, and input size.

Common mistakes:
- Counting a repeated day twice, or letting it break the run in the sorted
  version.
- Assuming the days are sorted.
- Walking forward from every day, which is O(n²) on one long streak.
- Returning 1 for an empty list.

## Follow-up at minute 45 (or once the tests pass)

`longest_streak_with_freezes(days, freezes)`: sort the distinct days, then a
sliding window over them. A window from `posted[left]` to `posted[right]` is
missing `(posted[right] - posted[left] + 1) - (right - left + 1)` days; shrink it
while that's more than `freezes`. The answer is the widest window's span:
O(n log n) for the sort, then O(n). Trying every pair of days is O(n²) and fails
the large test. A streak starts and ends on a day with a note, so leftover
freezes don't add days.

## Follow-up questions to ask

- Can you get the first part to O(n) without sorting?
- What would you change if the days streamed in one at a time and the app showed the current streak live?
- How would you show every creator's streak if the notes were spread across many machines?

## Signals

Green: clarifies repeated days and ordering before coding; states the
complexity unprompted; walks through the example out loud; owns their stories
with specifics and numbers; asks thoughtful questions about the team.
Red: starts coding immediately; silent for long stretches; "we" stories with no
personal actions; can't explain their own code's complexity.
