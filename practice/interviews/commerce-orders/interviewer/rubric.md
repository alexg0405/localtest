# Scoring rubric: Order service

Score each area 1–5, or "not observed" when there is no evidence. Using the
coding assistant a lot is not a negative; judge the quality of direction and
checking, not the amount.

| Area | 1 | 3 | 5 |
|---|---|---|---|
| Problem understanding | Starts coding without asking what a duplicate is or how failures behave. | Asks about duplicates and pagination. | Also asks about failed payments, retry limits, and cancel rules, and states assumptions. |
| Repository exploration | Edits files without reading how they connect. | Traces `place_order` through inventory, payments, and the repository. | Explains where state can be left half-changed before changing it. |
| Quality of AI instructions | Vague asks ("fix it"). | Names files and the behaviour to fix. | Gives constraints (keep signatures, don't edit tests), asks for a diff or plan first, asks for tests. |
| Verification of AI output | Accepts output unread. | Runs tests after changes. | Reads diffs, pushes back on wrong output, and finds the patch's failure sequence. |
| Correctness and edge cases | Duplicate or pagination still broken. | Both reports fixed and cancel works. | Also stock rollback, retry limits, declined cards, the change, and pagination edges. |
| Testing | No new tests. | A regression test per report. | Tests that fail on the starter for each bug, plus cancel and change tests. |
| Code quality | Large rewrite, leftover debugging. | Focused fix. | Small helpers (reserve/release), clear names, no dead code. |
| Communication and tradeoffs | Cannot explain the change. | Explains what changed. | Explains why, the tradeoffs (key expiry, crash between charge and store), and what is left. |

The dashboard's automatic scores are heuristics from test results, diffs, and the
text you recorded. Use the grading prompt with a separate Claude conversation, or
a human, for a second opinion.
