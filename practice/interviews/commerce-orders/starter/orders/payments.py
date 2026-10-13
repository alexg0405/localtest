from __future__ import annotations

from typing import List, Optional, Tuple


class TransientPaymentError(Exception):
    """The gateway timed out or returned a 5xx. Safe to retry with the same idempotency key."""


class PaymentDeclined(Exception):
    """The card was declined. Retrying will not help."""


class FakePaymentGateway:
    """Stands in for the real gateway in development and tests.

    `script` lists the outcome of each call in order: "ok", "transient", or "declined".
    Once the script runs out, every charge succeeds.
    """

    def __init__(self, script: Optional[List[str]] = None):
        self.script = list(script or [])
        self.calls = 0
        self.charges: List[Tuple[str, int, str]] = []  # (customer_id, amount_cents, idempotency_key)

    def charge(self, customer_id: str, amount_cents: int, idempotency_key: str) -> str:
        self.calls += 1
        outcome = self.script.pop(0) if self.script else "ok"
        if outcome == "transient":
            raise TransientPaymentError("gateway timeout")
        if outcome == "declined":
            raise PaymentDeclined("card declined")
        self.charges.append((customer_id, amount_cents, idempotency_key))
        return f"ch_{len(self.charges)}"
