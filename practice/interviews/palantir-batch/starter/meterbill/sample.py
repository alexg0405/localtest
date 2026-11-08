"""A sample night: one day's smart-meter readings for eleven accounts, for tests and for trying things out.

A real night is about 38 million readings. This one has the same shape: every meter sends a reading every 15
minutes (96 a day), the head-end exports them grouped by account, then meter, then time, and watt-hours come as
text, the way the head-end's export writes them.
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional

DAY = "2026-11-02"
NEXT_DAY = "2026-11-03"

# account -> its meters. R- are homes, B- small businesses, C- commercial sites with a meter per building.
METERS: Dict[str, List[str]] = {
    "R-100": ["M-1000"],
    "R-101": ["M-1010"],
    "R-102": ["M-1020"],
    "R-103": ["M-1030"],
    "R-104": ["M-1040"],
    "C-200": ["M-2000", "M-2001", "M-2002", "M-2003", "M-2004", "M-2005"],   # a cold-storage warehouse
    "B-300": ["M-3000", "M-3001"],
    "B-301": ["M-3010", "M-3011"],
    "C-201": ["M-2010", "M-2011", "M-2012", "M-2013"],   # a parcel distribution center
    "R-105": ["M-1050"],
    "R-106": ["M-1060"],
}
ACCOUNTS = list(METERS)

# Readings the meters never sent: meter -> the 15-minute slots (0 to 95) that are missing.
GAPS: Dict[str, Iterable[int]] = {
    "M-1010": range(40, 46),   # six missing in the afternoon
    "M-3001": [12],
    "M-2003": range(0, 20),
    "M-1060": range(90, 96),
}

_BASE = {"R": 150, "B": 600, "C": 2500}   # typical watt-hours per 15 minutes, by kind of account


def _slot_time(day: str, slot: int) -> str:
    return f"{day}T{slot // 4:02d}:{slot % 4 * 15:02d}"


def _wh(meter: str, slot: int, kind: str) -> int:
    number = int(meter[2:])
    daytime = 1.6 if 28 <= slot < 76 else 1.0
    return int(_BASE[kind] * daytime) + (number * 37 + slot * 53) % (_BASE[kind] // 3)


def readings(day: str = DAY, accounts: Optional[Iterable[str]] = None, gaps: bool = True) -> List[Dict[str, str]]:
    """The night's readings for `accounts` (all of them by default), in the head-end's order. With gaps=False, every
    meter sent all 96."""
    out = []
    for account in (ACCOUNTS if accounts is None else list(accounts)):
        for meter in METERS[account]:
            missing = set(GAPS.get(meter, ())) if gaps else set()
            for slot in range(96):
                if slot not in missing:
                    out.append({"meter": meter, "account": account, "ts": _slot_time(day, slot), "wh": str(_wh(meter, slot, account[0]))})
    return out


def meter_totals(readings: Iterable[Dict[str, str]]) -> Dict[str, float]:
    """Each account's kWh, added up straight from the readings (skipping any that aren't a whole number of
    watt-hours, zero or more): what the meters say the job should get."""
    totals: Dict[str, int] = {}
    for reading in readings:
        text = str(reading.get("wh", ""))
        if text.isdigit():
            totals[reading["account"]] = totals.get(reading["account"], 0) + int(text)
    return {account: round(wh / 1000, 3) for account, wh in totals.items()}
