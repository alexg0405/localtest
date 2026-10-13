from __future__ import annotations

import re

_AMOUNT = re.compile(r"([0-9]+)(?:\.([0-9]{1,2}))?")


class InvalidAmount(ValueError):
    pass


def parse_amount(text: str) -> int:
    """Converts a dollar amount such as "12.34" to integer cents, exactly (no floats)."""
    match = _AMOUNT.fullmatch(text) if isinstance(text, str) else None
    if match is None:
        raise InvalidAmount(f"invalid amount: {text!r}")
    dollars, fraction = match.group(1), match.group(2) or ""
    return int(dollars) * 100 + int(fraction.ljust(2, "0"))


def format_cents(cents: int) -> str:
    """Formats integer cents as dollars, for example 123456 -> "$1234.56" and -5 -> "-$0.05"."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100}.{cents % 100:02d}"
