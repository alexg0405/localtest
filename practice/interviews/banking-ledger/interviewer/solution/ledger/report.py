from __future__ import annotations

from datetime import timezone
from typing import Any, Dict, List

from .processor import LedgerResult


def _utc_day(txn) -> str:
    return txn.timestamp.astimezone(timezone.utc).date().isoformat()


def daily_totals(result: LedgerResult) -> Dict[str, Dict[str, int]]:
    """Totals of applied transactions per UTC calendar day, oldest first.

    Returns {"2026-03-01": {"credits": cents, "debits": cents, "count": n}, ...}.
    """
    totals: Dict[str, Dict[str, int]] = {}
    for txn in result.applied:
        bucket = totals.setdefault(_utc_day(txn), {"credits": 0, "debits": 0, "count": 0})
        bucket["credits" if txn.kind == "credit" else "debits"] += txn.amount_cents
        bucket["count"] += 1
    return dict(sorted(totals.items()))


def account_statement(result: LedgerResult, account_id: str) -> Dict[str, Any]:
    """The statement for one account, in processing order.

    Only applied transactions appear. Credits are positive and debits negative;
    "date" is the UTC date; "balance_cents" is the balance after that line.
    """
    opening = result.opening_balances.get(account_id, 0)
    balance = opening
    lines: List[Dict[str, Any]] = []
    for txn in result.applied:
        if txn.account_id != account_id:
            continue
        signed = txn.amount_cents if txn.kind == "credit" else -txn.amount_cents
        balance += signed
        lines.append({"event_id": txn.event_id, "date": _utc_day(txn), "amount_cents": signed, "balance_cents": balance})
    return {"account_id": account_id, "opening_cents": opening, "closing_cents": balance, "lines": lines}
