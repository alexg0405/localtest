"""The nightly billing job: turns the day's smart-meter readings into each account's usage, then into charges.

Every night the meters' head-end exports the day's 15-minute readings, and this job:
  1. adds up each account's usage for the day, into the daily_usage table, then
  2. prices that usage, into the charges table, which the billing system bills from in the morning.
It's built on sluice, our team's batch processor (see the Docs tab). You'll change this file.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping

import sluice

BATCH_SIZE = 500          # readings per batch
RATE_PER_KWH = 0.21       # dollars per kWh
DAILY_FEE = 0.40          # dollars per account per day
READINGS_PER_DAY = 96     # a healthy meter sends one every 15 minutes


def parse_reading(reading: Mapping[str, Any]) -> Dict[str, Any]:
    """One reading from the head-end, with its watt-hours as a number."""
    wh = int(reading["wh"])
    if wh < 0:
        raise ValueError(f"meter {reading['meter']} sent a negative reading: {wh}")
    return {"account": reading["account"], "meter": reading["meter"], "ts": reading["ts"], "wh": wh}


def to_usage(total: Mapping[str, Any], day: str) -> Dict[str, Any]:
    """An account's total for the day, as a daily_usage row."""
    return {"account": total["account"], "day": day, "kwh": round(total["wh"] / 1000, 3), "readings": total["readings"]}


def to_charge(usage: Mapping[str, Any]) -> Dict[str, Any]:
    """A daily_usage row, priced: what the account owes for that day."""
    return {"account": usage["account"], "day": usage["day"], "kwh": usage["kwh"],
            "amount": round(usage["kwh"] * RATE_PER_KWH + DAILY_FEE, 2)}


def daily_usage(readings: Iterable[Mapping[str, Any]], store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> sluice.RunReport:
    """Each account's usage for the day, into the daily_usage table: one row per account and day."""
    pipeline = (sluice.Pipeline(readings, batch_size=batch_size, name="daily_usage")
                .map(parse_reading, name="parse")
                .aggregate(by="account", wh=sluice.Sum("wh"), readings=sluice.Count(), name="total")
                .map(lambda total: to_usage(total, day), name="to_usage")
                .sink(store.table("daily_usage"), mode="upsert", key=("account", "day")))
    return pipeline.run()


def charges(store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> sluice.RunReport:
    """Prices the day's usage into the charges table."""
    pipeline = (sluice.Pipeline(lambda: store.table("daily_usage").find(day=day), batch_size=batch_size, name="charges")
                .map(to_charge, name="price")
                .sink(store.table("charges")))
    return pipeline.run()


def meter_gaps(readings: Iterable[Mapping[str, Any]], store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> sluice.RunReport:
    """Part 1: meters that sent fewer readings than they should have, into the meter_gaps table. See TASKS.md."""
    raise NotImplementedError("part 1")


def run_nightly(readings: Iterable[Mapping[str, Any]], store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> Dict[str, sluice.RunReport]:
    """The whole night: usage, then charges. Returns each pipeline's run report, by pipeline name."""
    readings = list(readings)
    return {
        "daily_usage": daily_usage(readings, store, day, batch_size),
        "charges": charges(store, day, batch_size),
    }
