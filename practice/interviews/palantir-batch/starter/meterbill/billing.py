"""What the billing system does with the job's tables each morning. It belongs to the utility's billing team: it only
reads, and you can't change it.

It reads two tables:
- daily_usage: one row per account per day. {"account", "day", "kwh", "readings"}
- charges: what each account owes for a day. {"account", "day", "kwh", "amount"}
Every charges row for an account and day goes on that account's bill.
"""
from __future__ import annotations

from typing import Dict

import sluice


def bill_for(store: sluice.Store, account: str, day: str) -> float:
    """What the account is billed for the day: every charge for it, added up."""
    return round(sum(row["amount"] for row in store.table("charges").find(account=account, day=day)), 2)


def usage_for(store: sluice.Store, account: str, day: str) -> float:
    """The kWh shown on the account's online usage page for the day."""
    rows = store.table("daily_usage").find(account=account, day=day)
    return rows[0]["kwh"] if rows else 0.0


def bills(store: sluice.Store, day: str) -> Dict[str, float]:
    """Every account billed for the day, and how much."""
    accounts = sorted({row["account"] for row in store.table("charges").find(day=day)})
    return {account: bill_for(store, account, day) for account in accounts}
