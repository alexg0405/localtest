from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict

from .money import InvalidAmount, parse_amount

REQUIRED_FIELDS = ("event_id", "account_id", "type", "amount", "timestamp")


class InvalidEvent(ValueError):
    pass


@dataclass(frozen=True)
class Transaction:
    event_id: str
    account_id: str
    kind: str  # "credit" or "debit"
    amount_cents: int
    timestamp: datetime
    description: str = ""


def parse_event(raw: Dict[str, Any]) -> Transaction:
    """Validates one raw event from the feed and turns it into a Transaction."""
    missing = [field for field in REQUIRED_FIELDS if field not in raw]
    if missing:
        raise InvalidEvent(f"missing fields: {', '.join(missing)}")
    try:
        amount = parse_amount(str(raw["amount"]))
    except InvalidAmount as error:
        raise InvalidEvent(str(error)) from error
    try:
        timestamp = datetime.fromisoformat(str(raw["timestamp"]).replace("Z", "+00:00"))
    except ValueError as error:
        raise InvalidEvent(f"invalid timestamp: {raw['timestamp']!r}") from error
    return Transaction(
        event_id=str(raw["event_id"]),
        account_id=str(raw["account_id"]),
        kind=str(raw["type"]).lower(),
        amount_cents=amount,
        timestamp=timestamp,
        description=str(raw.get("description", "")),
    )
