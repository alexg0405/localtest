# Interviewer guide: Transaction ledger

Spoilers: this file lists the planted defects and the answers. Keep it out of the
candidate's workspace and out of the coding assistant's reach.

## What this exercise checks

Handling money exactly, validating untrusted input, making an at-least-once
feed safe with duplicate detection, and timezone-correct reporting. All data is
synthetic.

## Planted defects

| Where | Defect | Visible test that catches it |
|---|---|---|
| `money.parse_amount` | `int(float(text) * 100)` truncates: "19.99" becomes 1998, "0.29" becomes 28. It also accepts "1e3", "1.005", "-5", and " 5". | `test_parse_amount_is_exact` |
| `money.format_cents` | Floor division on negatives: -5 cents prints `$-1.95`. | none (grading only; matters after the change) |
| `events.parse_event` | No check of `type` (an unknown type such as `refund` is applied as a credit, and `CREDIT` is lowercased), no currency check, zero or negative amounts allowed, JSON number amounts accepted, naive timestamps accepted. | none (grading only) |
| `processor.process` | `_seen` is filled but never checked, so duplicates are applied again. | `test_duplicate_event_is_applied_once` |
| `processor.process` | No funds check on debits. | `test_debit_that_overdraws_is_rejected` |
| `report.daily_totals` | Uses the event's local date, not the UTC date. | none (grading only) |
| `report.account_statement` | Not implemented. | `test_account_statement_running_balance` |

`examples/events.jsonl` contains one of each problem, so running the example
before and after is a quick way for the candidate to see the effect.

## Timeline

- 0–5: questions. Answer from `clarifications.json`; the important topics are
  duplicates, amount format, invalid events, funds, UTC days, and statements.
- 5–15: ask them to trace one event through loader, events, processor, report.
- 15–40: implementation. Ask how they are checking the assistant's money code.
- 30: reveal the overdraft change (`change_request.md`).
- 40–50: edge cases and patch review.
- 50–60: explanation and tradeoffs.

## Requirement change at minute 30

Overdraft down to -$50.00, configurable with `overdraft_limit_cents` (default
5000, 0 restores the old rule). It exposes the `format_cents` negative bug, and
the boundary (exactly -$50.00 allowed, -$50.01 rejected) is easy to get wrong
with `<` versus `<=`.

## AI patch review

The patch changes truncation to `round(float(text) * 100)`. The visible cases
pass, but money still goes through a float: "1.005" and "1e3" are silently
accepted, amounts beyond about 2^53 cents lose cents, and JSON numbers still
pass because the event parser calls `str()`. The added tests are all happy-path
values. A good review asks for exact string parsing (or `Decimal` with explicit
validation) and rejection tests.

## Follow-up questions to ask

- Why integer cents instead of `Decimal` everywhere? When would you choose
  `Decimal`?
- Seen event ids grow forever. How would you bound that in production?
- If the job crashes halfway through a batch and the batch is replayed, what
  happens with your design?
- Should an invalid event's id count as seen? What are the risks either way?

## Signals

Green: writes a failing test for the cent error before fixing it; validates at
the boundary (the parser) rather than in the processor; treats the feed as
untrusted; checks the overdraft boundary exactly. Red: "fixes" money with
`round()`; deletes or loosens visible tests; sorts events by timestamp without
asking.
