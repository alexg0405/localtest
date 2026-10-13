from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict

from .money import InvalidAmount, parse_amount

REQUIRED_FIELDS = ("event_id", "account_id", "type", "amount", "timestamp")
KINDS = ("credit", "debit")


class InvalidEvent(ValueError):
    pass


@dataclass(frozen=True)
class Transaction:
    event_id: str
    account_id: str
    kind: str  # "credit" or "debit"
    amount_cents: int
    timestamp: datetime  # always timezone-aware, in UTC
    description: str = ""


def parse_event(raw: Dict[str, Any]) -> Transaction:
    """Validates one raw event from the feed and turns it into a Transaction."""
    if not isinstance(raw, dict):
        raise InvalidEvent("event is not an object")
    missing = [field for field in REQUIRED_FIELDS if field not in raw]
    if missing:
        raise InvalidEvent(f"missing fields: {', '.join(missing)}")

    kind = raw["type"]
    if kind not in KINDS:
        raise InvalidEvent(f"unsupported type: {kind!r}")
    currency = raw.get("currency", "USD")
    if currency != "USD":
        raise InvalidEvent(f"unsupported currency: {currency!r}")
    if not isinstance(raw["amount"], str):
        raise InvalidEvent("amount must be a string")
    try:
        amount = parse_amount(raw["amount"])
    except InvalidAmount as error:
        raise InvalidEvent(str(error)) from error
    if amount <= 0:
        raise InvalidEvent("amount must be positive")

    try:
        timestamp = datetime.fromisoformat(str(raw["timestamp"]).replace("Z", "+00:00"))
    except ValueError as error:
        raise InvalidEvent(f"invalid timestamp: {raw['timestamp']!r}") from error
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise InvalidEvent("timestamp needs a timezone")

    return Transaction(
        event_id=str(raw["event_id"]),
        account_id=str(raw["account_id"]),
        kind=kind,
        amount_cents=amount,
        timestamp=timestamp.astimezone(timezone.utc),
        description=str(raw.get("description", "")),
    )
