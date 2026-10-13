from __future__ import annotations

from typing import Any, Dict

from .processor import LedgerResult


def daily_totals(result: LedgerResult) -> Dict[str, Dict[str, int]]:
    """Totals of applied transactions per UTC calendar day, oldest first.

    Returns {"2026-03-01": {"credits": cents, "debits": cents, "count": n}, ...}.
    """
    totals: Dict[str, Dict[str, int]] = {}
    for txn in result.applied:
        day = txn.timestamp.date().isoformat()
        bucket = totals.setdefault(day, {"credits": 0, "debits": 0, "count": 0})
        bucket["credits" if txn.kind == "credit" else "debits"] += txn.amount_cents
        bucket["count"] += 1
    return dict(sorted(totals.items()))


def account_statement(result: LedgerResult, account_id: str) -> Dict[str, Any]:
    """The statement for one account, in processing order.

    Returns:
        {
            "account_id": "acct-1",
            "opening_cents": 10000,
            "closing_cents": 7500,
            "lines": [
                {"event_id": "evt-1", "date": "2026-03-01", "amount_cents": -2500, "balance_cents": 7500},
            ],
        }

    Only applied transactions appear. Credits are positive and debits negative;
    "date" is the UTC date; "balance_cents" is the balance after that line.
    """
    raise NotImplementedError("account_statement is not implemented yet")
