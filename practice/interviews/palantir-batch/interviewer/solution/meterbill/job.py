"""The nightly billing job: turns the day's smart-meter readings into each account's usage, then into charges.

Reference solution for all four parts: a meter_gaps pipeline (part 1), charges upserted by account and day so a
re-run replaces them (part 2), aggregates over the whole run instead of each batch (part 3), and bad readings
dead-lettered by the parse step and written to bad_readings instead of stopping the night (part 4).
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
    """Each account's usage for the day, into the daily_usage table: one row per account and day. A reading that
    doesn't parse is dead-lettered, not fatal (it's in the report's dead_letters)."""
    pipeline = (sluice.Pipeline(readings, batch_size=batch_size, name="daily_usage")
                .map(parse_reading, name="parse", on_error="dead_letter")
                .aggregate(by="account", wh=sluice.Sum("wh"), readings=sluice.Count(), scope="run", name="total")   # one total per account, not per batch
                .map(lambda total: to_usage(total, day), name="to_usage")
                .sink(store.table("daily_usage"), mode="upsert", key=("account", "day")))
    return pipeline.run()


def charges(store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> sluice.RunReport:
    """Prices the day's usage into the charges table. Upserted by account and day, so a re-run replaces the day's
    charges instead of adding a second set."""
    pipeline = (sluice.Pipeline(lambda: store.table("daily_usage").find(day=day), batch_size=batch_size, name="charges")
                .map(to_charge, name="price")
                .sink(store.table("charges"), mode="upsert", key=("account", "day")))
    return pipeline.run()


def meter_gaps(readings: Iterable[Mapping[str, Any]], store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> sluice.RunReport:
    """Meters that sent fewer than 96 readings, into the meter_gaps table, one row per meter and day. Every reading
    counts, even one that won't parse: the meter still reported."""
    pipeline = (sluice.Pipeline(readings, batch_size=batch_size, name="meter_gaps")
                .aggregate(by=("meter", "account"), readings=sluice.Count(), scope="run", name="count")
                .filter(lambda meter: meter["readings"] < READINGS_PER_DAY, name="short")
                .map(lambda meter: {**meter, "day": day, "missing": READINGS_PER_DAY - meter["readings"]}, name="to_gap")
                .sink(store.table("meter_gaps"), mode="upsert", key=("meter", "day")))
    return pipeline.run()


def bad_readings(usage: sluice.RunReport, store: sluice.Store) -> sluice.RunReport:
    """The readings the parse step couldn't use, into the bad_readings table for the metering team, one row per
    meter and time."""
    rows = [{"meter": letter.record.get("meter"), "account": letter.record.get("account"), "ts": letter.record.get("ts"),
             "wh": letter.record.get("wh"), "error": f"{type(letter.error).__name__}: {letter.error}"}
            for letter in usage.dead_letters if letter.step == "parse"]
    return sluice.Pipeline(rows, name="bad_readings").sink(store.table("bad_readings"), mode="upsert", key=("meter", "ts")).run()


def run_nightly(readings: Iterable[Mapping[str, Any]], store: sluice.Store, day: str, batch_size: int = BATCH_SIZE) -> Dict[str, sluice.RunReport]:
    """The whole night: usage (and its bad readings), charges, and meter gaps. Returns each pipeline's run report, by
    pipeline name. Safe to re-run."""
    readings = list(readings)
    usage = daily_usage(readings, store, day, batch_size)
    return {
        "daily_usage": usage,
        "bad_readings": bad_readings(usage, store),
        "charges": charges(store, day, batch_size),
        "meter_gaps": meter_gaps(readings, store, day, batch_size),
    }
