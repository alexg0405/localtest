# Scoring rubric: Transaction ledger

Score each area 1–5, or "not observed" when there is no evidence. Using the
coding assistant a lot is not a negative; judge the quality of direction and
checking, not the amount.

| Area | 1 | 3 | 5 |
|---|---|---|---|
| Problem understanding | Codes without asking about amount format or duplicates. | Asks about duplicates and rounding. | Also asks about invalid events, UTC days, funds edges, and states assumptions. |
| Repository exploration | Edits the first file found. | Traces an event through loader, events, processor, report. | Identifies that validation belongs in the parser and duplicates in the processor before editing. |
| Quality of AI instructions | "Fix the bug." | Names files and expected behaviour. | Forbids floats explicitly, asks for rejection cases, asks for a plan or diff before edits. |
| Verification of AI output | Accepts money code unread. | Runs the tests. | Tries adversarial amounts against the assistant's code; catches the patch's float rounding. |
| Correctness and edge cases | Cent error or duplicates remain. | All reports fixed, statement works. | Also validation, UTC days, later-batch duplicates, and the overdraft boundary. |
| Testing | No new tests. | One regression test per report. | Parametrized amount tests, rejection tests, and change tests that fail on the starter. |
| Code quality | Validation scattered, floats remain. | Focused fixes. | Exact parsing, validation at the boundary, small clear functions. |
| Communication and tradeoffs | Cannot explain the fix. | Explains what changed. | Explains integer cents versus Decimal, unbounded seen ids, and replay safety. |

The dashboard's automatic scores are heuristics from test results, diffs, and the
text you recorded. Use the grading prompt with a separate Claude conversation, or
a human, for a second opinion.
