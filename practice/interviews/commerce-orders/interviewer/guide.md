# Interviewer guide: Order service

Spoilers: this file lists the planted defects and the answers. Keep it out of the
candidate's workspace and out of the coding assistant's reach.

## What this exercise checks

Debugging a small service the candidate did not write, reasoning about partial
failure (stock reserved, then payment fails), idempotency, and an off-by-one in
pagination. The cancel feature is small; correctness of its edge cases matters
more than speed.

## Planted defects

| Where | Defect | Visible test that catches it |
|---|---|---|
| `service.place_order` | The duplicate check looks for the `request_id` in the orders dict, which is keyed by order id, so it never matches: every retry places, charges, and reserves again. | `test_same_request_id_returns_the_same_order` |
| `service.place_order` | If a later item is out of stock (or quantity is invalid), stock already reserved for earlier items is never returned. | none (grading only) |
| `service.place_order` | When payment fails, reserved stock is never returned. | none (grading only) |
| `service.place_order` + `retry.with_retries` | Retries every exception, including `PaymentDeclined`. | none (grading only) |
| `retry.with_retries` | `range(max_attempts + 1)` makes 4 attempts, and it sleeps after the last one. | none (grading only) |
| `repository.list_orders` | `start = int(token) + 1` skips the first order of every page after the first. | `test_pages_return_every_order_once` |
| `service.cancel_order` | Not implemented. | `test_cancel_returns_stock` |

A strong candidate finds the duplicate and pagination bugs from the reports,
then notices the partial-failure stock leaks by reading `place_order` or by
asking "what happens when payment fails?".

## Timeline

- 0–5: candidate reads the task and asks questions. Answer from the table below.
- 5–15: ask them to walk you through `place_order` and say where state can be
  left half-changed.
- 15–40: implementation. Ask what they told the assistant, and whether they
  read its diff before accepting it.
- 30: reveal the requirement change (`change_request.md`; the dashboard does this
  automatically).
- 40–50: edge cases and the patch review.
- 50–60: explanation and tradeoffs.

## Answers to likely clarification questions

The dashboard answers these automatically from `clarifications.json`. The
important ones:

- Duplicates are defined by `request_id` alone. Return the original order with
  no new charge or reservation.
- A request that failed placed nothing, so the same `request_id` may be retried.
- Retry only `TransientPaymentError`, 3 attempts in total; declined fails at once.
- Every failure path returns every reserved unit.
- Pages are in creation order, with no gaps, repeats, or trailing empty page;
  `limit` is 1 to 100.
- Only `PLACED` orders can be cancelled; cancelling twice is a no-op; `SHIPPED`
  raises `InvalidTransition`.
- Out of scope: refunds, threads, persistence. Mentioning them is a plus.

## Requirement change at minute 30

Reused `request_id` with a different customer or items raises
`IdempotencyConflict` (a new `OrderError` subclass). Item order does not matter.
Watch whether the candidate compares items as a multiset rather than a list, and
whether the conflict check happens before any reservation or charge.

## AI patch review

The patch fixes the lookup but adds the order and the `request_id` mapping
before charging. If payment fails, the unpaid order stays stored as `PLACED`,
the stock stays reserved, and a retry with the same `request_id` gets the unpaid
order back with no charge. Its new test passes only because payment succeeds.
A good review names the failure sequence (declined or 3 transient errors, then
the same `request_id` again) and proposes a test for it. Bonus: the patch still
retries declined cards.

## Follow-up questions to ask

- How would idempotency work across two app servers? (A shared store with a
  unique constraint on `request_id`, or the gateway's own idempotency key.)
- How long should idempotency keys live? What breaks if they never expire?
- Why does the gateway get the `request_id` as its idempotency key?
- What could still go wrong if the process crashes between charging and storing
  the order?

## Signals

Green: reproduces each report with a failing test before fixing it; reads the
assistant's diff; asks about failure paths; keeps signatures stable; explains
tradeoffs. Red: rewrites the service wholesale; edits visible tests to pass;
accepts the AI patch because "the tests pass".
