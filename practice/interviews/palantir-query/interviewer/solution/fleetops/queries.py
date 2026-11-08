"""The questions Tallwood Air's operations team asks of their data, as Weft queries.

Each function returns a query and its parameters, as (text, params). report.run sends them to the warehouse, which
runs them next to the data: the answer has to come from the query itself, not from Python afterwards. You'll add
to this file.

Reference solution for all four parts: `is missing` for aircraft with no status, group by with count(*) and a
$parameter for the limit, an inner join for our own fleet, and latest per defect before the filter.
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


def unavailable_aircraft() -> Query:
    """Part 1: every aircraft that isn't in service, by tail. No status yet means not signed off: unavailable too."""
    return """
        from aircraft
        where status != "in service" or status is missing   # != alone is false for a missing status
        sort tail
        select tail, model, base, status
    """, {}


def delays_by_aircraft(airport: str, top: int = 3) -> Query:
    """Part 2: the aircraft with the worst average delay on flights out of an airport."""
    return """
        from flights
        where origin == $airport
        group by tail
        compute flights = count(*), avg_delay = round(avg(delay), 1), worst = max(delay)   # count(*) keeps cancelled flights
        sort avg_delay desc, tail
        limit $top
    """, {"airport": airport, "top": top}


def hours_by_model(since: str) -> Query:
    """Part 3: hours flown by each model of our own fleet, on or after a date, most first."""
    return """
        from flights
        join inner aircraft on tail          # a plain join keeps the partner's flights, with no model
        where date >= $since and arrived is not missing
        group by model
        compute flights = count(*), hours = round(sum(hours_between(departed, arrived)), 1)
        sort hours desc, model
    """, {"since": since}


def open_defects(base: str) -> Query:
    """Part 4: the defects still open or deferred on the in-service aircraft at a base, oldest update first."""
    return """
        from defects
        latest per defect by at              # each defect's current row, before anything filters on its status
        join aircraft on tail                # the aircraft's status comes back as aircraft.status
        where status in ("open", "deferred") and aircraft.status == "in service" and base == $base
        sort at, defect
        select defect, tail, model, system, status, updated = at
    """, {"base": base}
