from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set

from .events import InvalidEvent, Transaction, parse_event

DEFAULT_OVERDRAFT_LIMIT_CENTS = 5000  # Requirement change: accounts may go down to -$50.00.


@dataclass(frozen=True)
class Rejection:
    event_id: Optional[str]
    reason: str


@dataclass
class LedgerResult:
    opening_balances: Dict[str, int]
    balances: Dict[str, int]
    applied: List[Transaction] = field(default_factory=list)
    rejected: List[Rejection] = field(default_factory=list)
    duplicates: List[str] = field(default_factory=list)


class LedgerProcessor:
    """Applies events to balances. Call `process` once per batch; state carries over."""

    def __init__(self, opening_balances: Optional[Dict[str, int]] = None, overdraft_limit_cents: int = DEFAULT_OVERDRAFT_LIMIT_CENTS):
        if overdraft_limit_cents < 0:
            raise ValueError("overdraft_limit_cents cannot be negative")
        self._opening = dict(opening_balances or {})
        self._balances: Dict[str, int] = dict(self._opening)
        self._overdraft_limit = overdraft_limit_cents
        self._applied: List[Transaction] = []
        self._rejected: List[Rejection] = []
        self._duplicates: List[str] = []
        self._seen: Set[str] = set()

    def process(self, raw_events: Iterable[Dict[str, Any]]) -> LedgerResult:
        for raw in raw_events:
            try:
                txn = parse_event(raw)
            except InvalidEvent as error:
                event_id = raw.get("event_id") if isinstance(raw, dict) else None
                self._rejected.append(Rejection(event_id, f"invalid: {error}"))
                continue

            # The queue delivers at least once: a redelivered event is skipped, even in a later batch.
            if txn.event_id in self._seen:
                self._duplicates.append(txn.event_id)
                continue
            self._seen.add(txn.event_id)

            balance = self._balances.get(txn.account_id, 0)
            if txn.kind == "debit":
                if balance - txn.amount_cents < -self._overdraft_limit:
                    self._rejected.append(Rejection(txn.event_id, "insufficient funds"))
                    continue
                balance -= txn.amount_cents
            else:
                balance += txn.amount_cents
            self._balances[txn.account_id] = balance
            self._applied.append(txn)
        return self.result()

    def result(self) -> LedgerResult:
        return LedgerResult(
            opening_balances=dict(self._opening),
            balances=dict(self._balances),
            applied=list(self._applied),
            rejected=list(self._rejected),
            duplicates=list(self._duplicates),
        )
