"""The questions Tallwood Air's operations team asks of their data, as Weft queries.

Each function returns a query and its parameters, as (text, params). report.run sends them to the warehouse, which
runs them next to the data: the answer has to come from the query itself, not from Python afterwards. You'll add
to this file.
"""
from __future__ import annotations

from typing import Any, Dict, Tuple

Query = Tuple[str, Dict[str, Any]]


def fleet_at(base: str) -> Query:
    """Every aircraft based at an airport, by model, then tail."""
    return """
        from aircraft
        where base == $base
        sort model, tail
        select tail, model, status
    """, {"base": base}


def flights_for(tail: str) -> Query:
    """One aircraft's flights, oldest first."""
    return """
        from flights
        where tail == $tail
        sort date, departed
        select flight, date, origin, dest, departed, arrived, delay
    """, {"tail": tail}
