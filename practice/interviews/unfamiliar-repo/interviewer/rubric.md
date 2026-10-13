# Scoring rubric: catalog-pipeline (unfamiliar repository)

Score each area 1–5, or "not observed" when there is no evidence. Using the
coding assistant a lot is not a negative; judge the quality of direction and
checking, not the amount.

| Area | 1 | 3 | 5 |
|---|---|---|---|
| Problem understanding | Starts editing without reproducing or asking what changed. | Reproduces the failure and asks about the supplier change. | Also clarifies encoding, name fidelity, scope, and line numbers; states the hypothesis. |
| Repository exploration | Edits stages at random. | Explains config → runner → registry → stages. | Narrows the cause with evidence (repr of headers, bytes) before changing code. |
| Quality of AI instructions | "Make the job pass." | Gives the error and command. | Asks for hypotheses and how to confirm each, forbids test edits, asks for a minimal diff. |
| Verification of AI output | Accepts a passing run. | Re-runs the job and tests. | Checks output bytes for names; catches the patch's deleted assertion and mojibake. |
| Correctness and edge cases | Job still fails. | Job succeeds, names intact. | Also line numbers, BOM and no-BOM, the delimiter change, and the merge bug. |
| Testing | No new tests. | A test with a BOM fixture. | Regression tests that fail on the starter, plus change tests including partial options. |
| Code quality | Rewrite, or edits the example data. | Focused fix in the reader. | Minimal, explained fix; tested deep merge that does not mutate defaults. |
| Communication and tradeoffs | Cannot say what was wrong. | Explains the root cause. | Incident-style: symptom, cause, fix, verification, prevention, other findings. |

The dashboard's automatic scores are heuristics from test results, diffs, and the
text you recorded. Use the grading prompt with a separate Claude conversation, or
a human, for a second opinion.
