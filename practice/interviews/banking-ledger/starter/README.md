# Transaction ledger

This batch job applies a feed of **synthetic** card and deposit events to account
balances, then produces daily totals for finance. Events arrive as JSON lines
from an upstream queue that delivers **at least once**, so the same event can
arrive more than once, in the same batch or a later one.

Finance has raised three problems, and there is one missing feature:

1. Some balances are off by a cent compared with the source system.
2. A few deposits were counted twice after the queue was replayed.
3. Malformed events (a refund type we do not support, a euro amount) changed
   balances when they should have been rejected.
4. `report.account_statement` is not implemented.

Your interviewer plays the finance partner. Ask them about anything unclear.

## Event format

```json
{"event_id": "evt-1001", "account_id": "acct-1", "type": "credit", "amount": "125.00",
 "currency": "USD", "timestamp": "2026-03-01T14:05:00Z", "description": "Payroll"}
```

## Requirements

- Money is integer cents everywhere. `money.parse_amount` turns an amount string
  into cents. It accepts digits, optionally followed by `.` and one or two
  digits (`"7"`, `"7.5"`, `"7.50"`). Anything else (signs, exponents, spaces,
  thousands separators, more than two decimals) raises `InvalidAmount`.
- `money.format_cents` formats cents as dollars: `123456` → `"$1234.56"`,
  `-5` → `"-$0.05"`.
- An event is valid when it has every field shown above except `currency` and
  `description` (both optional), `type` is `credit` or `debit`, `amount` is a
  **string** for a positive amount, `currency` (if present) is `USD`, and
  `timestamp` is ISO 8601 **with a timezone**.
- `LedgerProcessor.process(events)` can be called with several batches:
  - Invalid events are recorded in `rejected` with a reason, and change nothing.
  - An event whose `event_id` was already processed is skipped and listed in
    `duplicates`.
  - A debit larger than the balance is rejected with the reason
    `"insufficient funds"`.
- `report.daily_totals(result)` totals applied transactions per **UTC** day.
- `report.account_statement(result, account_id)` returns the opening balance,
  each applied transaction for that account with a running balance, and the
  closing balance (see its docstring).

## Acceptance criteria

- `pytest -q` passes.
- Each of the three problems is fixed and has a regression test.
- `account_statement` works and is tested.
- You can explain your changes, assumptions, and tradeoffs.

## Try it

```sh
python examples/run_report.py
pytest -q
```

Run these with the practice virtualenv active: `source ~/interview-practice/.venv/bin/activate`
(the dashboard shows the exact command for your setup).

## Also in this session

- `patch_review/` holds a patch an AI assistant proposed for one of these
  problems. You will review it later (see `patch_review/REVIEW.md`).
- Partway through, the finance partner may change a requirement. It will appear
  in the dashboard and in `CHANGE_REQUEST.md` in this folder.

All account numbers, names, and amounts here are synthetic.
