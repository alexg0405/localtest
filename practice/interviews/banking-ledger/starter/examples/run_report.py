"""Processes examples/events.jsonl and prints balances, problems, and daily totals.

Run from the repository root:  python examples/run_report.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ledger.loader import load_events  # noqa: E402
from ledger.money import format_cents  # noqa: E402
from ledger.processor import LedgerProcessor  # noqa: E402
from ledger.report import daily_totals  # noqa: E402

events = load_events(Path(__file__).with_name("events.jsonl"))
result = LedgerProcessor(opening_balances={"acct-1": 0, "acct-2": 2500}).process(events)

print("Balances")
for account, cents in sorted(result.balances.items()):
    print(f"  {account}: {format_cents(cents)}")
print("Rejected:", [(r.event_id, r.reason) for r in result.rejected])
print("Duplicates:", result.duplicates)
print("Daily totals (UTC)")
for day, totals in daily_totals(result).items():
    print(f"  {day}: credits {format_cents(totals['credits'])}, debits {format_cents(totals['debits'])}, {totals['count']} transactions")
