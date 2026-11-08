"""Three days of Tallwood Air's warehouse: the fleet, the flights, and the defect log, for tests and for trying things out.

A missing value is None, as Weft returns it. Every time is UTC, written as ISO text ("2026-10-12T13:05").
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List

Table = List[Dict[str, Any]]

# Our aircraft. status is None for an aircraft that hasn't been signed off into service yet.
_AIRCRAFT = [
    # tail      model   base   status         seats
    ("N401TW", "E175", "PDX", "in service", 76),
    ("N402TW", "E175", "PDX", "in service", 76),
    ("N403TW", "E175", "PDX", "grounded", 76),
    ("N404TW", "E175", "BOI", "in service", 76),
    ("N405TW", "E175", "BOI", "heavy check", 76),
    ("N511TW", "Q400", "PDX", "in service", 76),
    ("N512TW", "Q400", "BOI", "in service", 76),
    ("N513TW", "Q400", "BOI", None, 76),
    ("N514TW", "Q400", "PDX", "in service", 76),
    ("N601TW", "A220", "PDX", None, 120),
    ("N602TW", "A220", "BOI", "in service", 120),
]

# Every flight under our flight numbers. A cancelled flight has no departed, arrived, or delay. The N8xxCC aircraft
# belong to Coastline Connect, a partner that flies some routes for us: they aren't in the aircraft table.
_FLIGHTS = [
    # flight  date          tail      from   to     departed  arrived   delay (minutes)
    ("TW101", "2026-10-12", "N401TW", "PDX", "SEA", "13:05", "14:00", 5),
    ("TW102", "2026-10-12", "N401TW", "SEA", "PDX", "15:10", "16:02", 10),
    ("TW103", "2026-10-12", "N401TW", "PDX", "BOI", "18:00", "19:20", 0),
    ("TW201", "2026-10-12", "N402TW", "PDX", "SFO", "14:30", "16:25", 30),
    ("TW202", "2026-10-12", "N402TW", "SFO", "PDX", "17:20", "19:05", 20),
    ("TW301", "2026-10-12", "N511TW", "PDX", "GEG", "13:40", "14:45", 0),
    ("TW302", "2026-10-12", "N511TW", "GEG", "PDX", "15:30", "16:30", 0),
    ("TW401", "2026-10-12", "N404TW", "BOI", "SLC", "14:00", "15:10", 15),
    ("TW402", "2026-10-12", "N404TW", "SLC", "BOI", "16:00", "17:05", 5),
    ("TW501", "2026-10-12", "N602TW", "BOI", "PDX", "13:15", "14:30", 45),
    ("TW502", "2026-10-12", "N602TW", "PDX", "BOI", "15:30", "16:45", 60),
    ("TW601", "2026-10-12", "N514TW", "PDX", "SEA", None, None, None),
    ("TW801", "2026-10-12", "N403TW", "PDX", "SLC", None, None, None),
    ("TW901", "2026-10-12", "N820CC", "PDX", "SEA", "19:00", "19:55", 0),
    ("TW902", "2026-10-12", "N820CC", "SEA", "PDX", "20:40", "21:35", 10),
    ("TW101", "2026-10-13", "N401TW", "PDX", "SEA", "13:00", "13:55", 0),
    ("TW102", "2026-10-13", "N401TW", "SEA", "PDX", "15:05", "15:58", 5),
    ("TW201", "2026-10-13", "N402TW", "PDX", "SFO", "14:55", "16:50", 55),
    ("TW202", "2026-10-13", "N402TW", "SFO", "PDX", None, None, None),
    ("TW301", "2026-10-13", "N511TW", "PDX", "GEG", "13:45", "14:50", 5),
    ("TW302", "2026-10-13", "N511TW", "GEG", "PDX", "15:30", "16:30", 0),
    ("TW401", "2026-10-13", "N404TW", "BOI", "SLC", "14:00", "15:05", 15),
    ("TW501", "2026-10-13", "N602TW", "BOI", "PDX", "13:00", "14:10", 30),
    ("TW502", "2026-10-13", "N602TW", "PDX", "BOI", None, None, None),
    ("TW601", "2026-10-13", "N514TW", "PDX", "SEA", "13:20", "14:15", 0),
    ("TW602", "2026-10-13", "N514TW", "SEA", "PDX", "15:00", "15:55", 0),
    ("TW701", "2026-10-13", "N512TW", "BOI", "GEG", "14:10", "15:25", 0),
    ("TW702", "2026-10-13", "N512TW", "GEG", "BOI", "16:15", "17:30", 10),
    ("TW901", "2026-10-13", "N820CC", "PDX", "SEA", "19:00", "19:58", 3),
    ("TW903", "2026-10-13", "N821CC", "BOI", "SEA", "13:30", "14:35", 0),
    ("TW101", "2026-10-14", "N401TW", "PDX", "SEA", "13:20", "14:15", 21),
    ("TW201", "2026-10-14", "N402TW", "PDX", "SFO", "14:30", "16:20", 0),
    ("TW301", "2026-10-14", "N511TW", "PDX", "GEG", "13:40", "14:40", 0),
    ("TW501", "2026-10-14", "N602TW", "BOI", "PDX", "13:10", "14:25", 40),
    ("TW502", "2026-10-14", "N602TW", "PDX", "BOI", "15:20", "16:30", 50),
    ("TW601", "2026-10-14", "N514TW", "PDX", "SEA", None, None, None),
    ("TW701", "2026-10-14", "N512TW", "BOI", "GEG", "14:05", "15:15", 0),
    ("TW901", "2026-10-14", "N820CC", "PDX", "SEA", None, None, None),
    ("TW903", "2026-10-14", "N821CC", "BOI", "SEA", "13:30", "14:40", 5),
]

# The defect log is append-only: every change to a defect adds a row. Line stations send their rows in late, so the
# log isn't in time order. A defect's current state is its row with the latest time.
_DEFECTS = [
    # defect   tail      at                  system          status      note
    ("D-101", "N401TW", "2026-10-10T08:00", "hydraulics", "open", "Seep at the left main gear actuator"),
    ("D-102", "N401TW", "2026-10-12T07:15", "cabin", "open", "Row 12 reading light inoperative"),
    ("D-101", "N401TW", "2026-10-11T09:30", "hydraulics", "deferred", "Within limits; deferred 10 days"),
    ("D-104", "N403TW", "2026-10-11T12:00", "engine", "open", "High EGT on engine 2"),
    ("D-105", "N511TW", "2026-10-09T10:00", "landing gear", "open", "Nose gear steering shimmy"),
    ("D-105", "N511TW", "2026-10-13T14:20", "landing gear", "open", "Shimmy reported again after the fix"),
    ("D-105", "N511TW", "2026-10-10T11:00", "landing gear", "closed", "Steering damper replaced"),
    ("D-102", "N401TW", "2026-10-12T16:40", "cabin", "closed", "Lamp replaced"),
    ("D-103", "N402TW", "2026-10-13T05:50", "avionics", "open", "Intermittent ADS-B fault"),
    ("D-106", "N404TW", "2026-10-12T09:00", "avionics", "open", "Weather radar inoperative"),
    ("D-107", "N820CC", "2026-10-12T11:00", "cabin", "open", "Aft lavatory door latch sticks"),
    ("D-108", "N514TW", "2026-10-12T18:00", "cabin", "deferred", "Galley oven inoperative"),
    ("D-108", "N514TW", "2026-10-14T07:00", "cabin", "closed", "Oven replaced"),
    ("D-109", "N601TW", "2026-10-13T10:00", "avionics", "open", "Navigation database out of date"),
    ("D-110", "N512TW", "2026-10-13T08:00", "hydraulics", "deferred", "Slow leak at the brake line; monitor"),
    ("D-111", "N514TW", "2026-10-14T06:30", "fuel", "open", "Erratic fuel quantity indication"),
    ("D-112", "N405TW", "2026-10-14T09:00", "structures", "open", "Corrosion found at the aft pressure bulkhead"),
]


def _time(date: str, clock: Any) -> Any:
    return None if clock is None else f"{date}T{clock}"


_TABLES: Dict[str, Table] = {
    "aircraft": [dict(zip(("tail", "model", "base", "status", "seats"), row)) for row in _AIRCRAFT],
    "flights": [{"flight": f, "date": d, "tail": t, "origin": o, "dest": to, "departed": _time(d, dep), "arrived": _time(d, arr), "delay": delay}
                for f, d, t, o, to, dep, arr, delay in _FLIGHTS],
    "defects": [dict(zip(("defect", "tail", "at", "system", "status", "note"), row)) for row in _DEFECTS],
}


def tables() -> Dict[str, Table]:
    """A fresh copy of every table, by name: aircraft, flights, and defects."""
    return copy.deepcopy(_TABLES)
