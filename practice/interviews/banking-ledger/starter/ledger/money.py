from __future__ import annotations


class InvalidAmount(ValueError):
    pass


def parse_amount(text: str) -> int:
    """Converts a dollar amount such as "12.34" to integer cents."""
    try:
        return int(float(text) * 100)
    except (TypeError, ValueError, OverflowError) as error:
        raise InvalidAmount(f"invalid amount: {text!r}") from error


def format_cents(cents: int) -> str:
    """Formats integer cents as dollars, for example 123456 -> "$1234.56"."""
    return f"${cents // 100}.{cents % 100:02d}"
