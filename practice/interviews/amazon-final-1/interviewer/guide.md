# Interviewer guide: Amazon SDE intern final round 1

Spoilers: this file has the answers. Keep it out of the candidate's workspace.

## What this round simulates

Candidate reports from Amazon's Summer 2026 and Winter 2027 SDE intern cycles
describe final rounds of 45–60 minutes:
- About 15–30 minutes of Leadership Principles questions, with probing
  follow-ups on deadlines, ownership, and what the candidate personally did.
- One business-framed coding problem at about LeetCode-medium difficulty, in a
  plain shared editor. Candidates explain the approach, analyze complexity, and
  dry-run the code by hand.
- Amazon asks candidates not to use generative AI tools in interviews unless
  explicitly permitted, so this round has no assistant.

## Leadership Principles

Two questions, three follow-ups each (`behavioral.json`): Ownership, then
Deliver Results / Bias for Action. Look for:
- a specific situation (not "I usually…")
- the candidate's own actions ("I", not "we")
- a result with a number
- what they learned

When an answer is thin, push on "what did *you* do?" and "how did you measure
it?".

## Coding problem

`top_late_carriers(records, k)`: count late packages per carrier using only each
package's last record, then return the top k by count, with ties alphabetical.

Good solutions:
- Build a dict of each package's last record, then a Counter per carrier: O(n).
- Pick the top k with `heapq.nsmallest(k, ..., key=(-count, name))` in O(m log k),
  or sort the carriers in O(m log m), which is fine to mention as the simpler
  option.
- Space is O(p + m) for p packages and m carriers.

Ambiguities a strong candidate asks about (see `clarifications.json`): ties,
repeated package ids, k out of range, carriers with no late packages, delivered
on the promised day, and input size.

Common mistakes:
- Counting every record instead of each package's last one.
- Using `>=` for late.
- Breaking ties by insertion order.
- Re-sorting all records for every query.
- Returning carriers with zero late packages when k is large.

## Follow-up at minute 33

`LateCarrierTracker` with `record` and `top`: keep per-package state and
per-carrier counts, update them in O(1) on each record (subtract the old
package's contribution first), and answer `top(k)` from the counts. Recomputing
from all records on every `top` call fails the performance test. Strong
candidates mention keeping a sorted structure or bucket counts if `top` is
called far more often than `record`.

## Follow-up questions to ask

- If k is tiny compared with the number of carriers, can you do better than sorting them all?
- How would this work if the records didn't fit in memory on one machine?
- What would you change if top() were called much more often than record()?

## Signals

Green: clarifies ties and duplicates before coding; states the complexity
unprompted; dry-runs the example out loud; owns their stories with numbers.
Red: starts coding immediately; silent for long stretches; "we" stories with no
personal actions; can't explain their own code's complexity.
