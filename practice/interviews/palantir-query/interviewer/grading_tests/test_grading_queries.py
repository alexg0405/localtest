"""Grading tests for the Palantir FDSE learning round on Weft. Kept out of the candidate workspace.

The expected answers come from plain Python over the sample tables, not from Weft.
"""
from collections import defaultdict
from datetime import datetime

import pytest

from fleetops import queries, sample
from fleetops.report import run


def query(name, *args, tables=None, **kwargs):
    """Runs the query a part added, failing clearly when the part isn't written yet."""
    function = getattr(queries, name, None)
    if function is None:
        pytest.fail(f"queries.py has no {name}() yet")
    built = function(*args, **kwargs)
    assert isinstance(built, tuple) and len(built) == 2 and isinstance(built[0], str) and isinstance(built[1], dict), f"{name}() should return (query, params)"
    return run(built, tables)


def with_rows(**changes):
    """The sample tables, with some replaced."""
    tables = sample.tables()
    tables.update(changes)
    return tables


def aircraft(tail, model="E175", base="PDX", status="in service"):
    return {"tail": tail, "model": model, "base": base, "status": status, "seats": 76}


def flight(tail, delay, origin="PDX", date="2026-10-12", departed="13:00", arrived="14:00"):
    flown = delay is not None
    return {"flight": "TW100", "date": date, "tail": tail, "origin": origin, "dest": "SEA",
            "departed": f"{date}T{departed}" if flown else None, "arrived": f"{date}T{arrived}" if flown else None, "delay": delay}


def expected_delays(airport):
    by_tail = defaultdict(list)
    for row in sample.tables()["flights"]:
        if row["origin"] == airport:
            by_tail[row["tail"]].append(row["delay"])
    rows = []
    for tail, delays in by_tail.items():
        flown = [d for d in delays if d is not None]
        rows.append({"tail": tail, "flights": len(delays), "avg_delay": round(sum(flown) / len(flown), 1) if flown else None, "worst": max(flown) if flown else None})
    rows.sort(key=lambda r: r["tail"])
    rows.sort(key=lambda r: -r["avg_delay"] if r["avg_delay"] is not None else float("inf"))
    return rows


def expected_hours(since):
    tables = sample.tables()
    model_of = {row["tail"]: row["model"] for row in tables["aircraft"]}
    flights, hours = defaultdict(int), defaultdict(float)
    for row in tables["flights"]:
        if row["date"] >= since and row["arrived"] is not None and row["tail"] in model_of:
            model = model_of[row["tail"]]
            flights[model] += 1
            hours[model] += (datetime.fromisoformat(row["arrived"]) - datetime.fromisoformat(row["departed"])).total_seconds() / 3600
    rows = [{"model": m, "flights": flights[m], "hours": round(hours[m], 1)} for m in flights]
    return sorted(rows, key=lambda r: (-r["hours"], r["model"]))


def expected_defects(base):
    tables = sample.tables()
    fleet = {row["tail"]: row for row in tables["aircraft"]}
    current = {}
    for row in tables["defects"]:
        if row["defect"] not in current or row["at"] >= current[row["defect"]]["at"]:
            current[row["defect"]] = row
    rows = [{"defect": d["defect"], "tail": d["tail"], "model": fleet[d["tail"]]["model"], "system": d["system"], "status": d["status"], "updated": d["at"]}
            for d in current.values()
            if d["status"] in ("open", "deferred") and d["tail"] in fleet and fleet[d["tail"]]["status"] == "in service" and fleet[d["tail"]]["base"] == base]
    return sorted(rows, key=lambda r: (r["updated"], r["defect"]))


# What already worked

def test_the_existing_queries_still_work():
    assert [r["tail"] for r in run(queries.fleet_at("PDX"))] == ["N601TW", "N401TW", "N402TW", "N403TW", "N511TW", "N514TW"]
    assert len(run(queries.flights_for("N820CC"))) == 4


# Part 1: unavailable aircraft

def test_aircraft_with_no_status_are_unavailable():
    tails = [r["tail"] for r in query("unavailable_aircraft")]
    assert "N513TW" in tails and "N601TW" in tails


def test_aircraft_in_service_are_left_out():
    rows = query("unavailable_aircraft")
    assert [r["tail"] for r in rows] == ["N403TW", "N405TW", "N513TW", "N601TW"]
    assert all(r["status"] != "in service" for r in rows)


def test_unavailable_columns_and_order():
    tables = with_rows(aircraft=[aircraft("N9", status="grounded"), aircraft("N1", status=None), aircraft("N5"), aircraft("N3", base="BOI", status="paint")])
    assert query("unavailable_aircraft", tables=tables) == [
        {"tail": "N1", "model": "E175", "base": "PDX", "status": None},
        {"tail": "N3", "model": "E175", "base": "BOI", "status": "paint"},
        {"tail": "N9", "model": "E175", "base": "PDX", "status": "grounded"},
    ]


def test_a_fleet_all_in_service():
    assert query("unavailable_aircraft", tables=with_rows(aircraft=[aircraft("N1"), aircraft("N2")])) == []


# Part 2: delays by aircraft

def test_cancelled_flights_count_but_dont_change_the_average():
    assert query("delays_by_aircraft", "PDX", top=10) == expected_delays("PDX")


def test_top_limits_the_rows():
    assert [r["tail"] for r in query("delays_by_aircraft", "PDX", top=1)] == ["N602TW"]
    assert len(query("delays_by_aircraft", "PDX", top=20)) == 7


def test_another_airport():
    assert query("delays_by_aircraft", "BOI", top=10) == expected_delays("BOI")


def test_an_aircraft_whose_flights_were_all_cancelled_comes_last():
    last = query("delays_by_aircraft", "PDX", top=10)[-1]
    assert last == {"tail": "N403TW", "flights": 1, "avg_delay": None, "worst": None}


def test_ties_go_by_tail():
    tables = with_rows(flights=[flight("N9", 10), flight("N5", 20), flight("N1", 10), flight("N5", 0), flight("N3", 30)])
    assert [r["tail"] for r in query("delays_by_aircraft", "PDX", top=5, tables=tables)] == ["N3", "N1", "N5", "N9"]


def test_the_airport_is_a_parameter():
    assert query("delays_by_aircraft", 'PDX" or origin != "', top=10) == []


def test_an_airport_with_no_flights():
    assert query("delays_by_aircraft", "LAX") == []


# Part 3: hours by model

def test_partner_flights_are_left_out():
    rows = query("hours_by_model", "2026-10-12")
    assert all(r["model"] is not None for r in rows) and len(rows) == 3


def test_cancelled_flights_dont_count():
    assert query("hours_by_model", "2026-10-12") == expected_hours("2026-10-12")


def test_since_is_a_date_filter():
    assert query("hours_by_model", "2026-10-14") == expected_hours("2026-10-14")
    assert query("hours_by_model", "2026-10-13") == expected_hours("2026-10-13")


def test_a_date_after_every_flight():
    assert query("hours_by_model", "2026-11-01") == []


# Part 4: the defect briefing

def test_a_defect_closed_since_isnt_in_the_briefing():
    defects = [r["defect"] for r in query("open_defects", "PDX")]
    assert "D-102" not in defects and "D-108" not in defects


def test_a_reopened_defect_is_open():
    rows = [r for r in query("open_defects", "PDX") if r["defect"] == "D-105"]
    assert len(rows) == 1 and rows[0]["status"] == "open" and rows[0]["updated"] == "2026-10-13T14:20"


def test_only_aircraft_in_service():
    defects = {r["defect"] for b in ("PDX", "BOI") for r in query("open_defects", b)}
    assert defects == {"D-101", "D-103", "D-105", "D-111", "D-106", "D-110"}   # not D-104 (grounded), D-109 (no status), D-112 (check), D-107 (partner)


def test_the_boise_briefing():
    assert query("open_defects", "BOI") == expected_defects("BOI")


def test_the_status_is_the_defects():
    rows = query("open_defects", "PDX")
    assert rows == expected_defects("PDX") and {r["status"] for r in rows} == {"open", "deferred"}


def test_the_latest_row_wins_wherever_it_is_in_the_log():
    log = [
        {"defect": "D-1", "tail": "N1", "at": "2026-10-14T09:00", "system": "fuel", "status": "closed", "note": ""},
        {"defect": "D-1", "tail": "N1", "at": "2026-10-12T09:00", "system": "fuel", "status": "open", "note": ""},
        {"defect": "D-2", "tail": "N1", "at": "2026-10-13T09:00", "system": "cabin", "status": "deferred", "note": ""},
        {"defect": "D-2", "tail": "N1", "at": "2026-10-11T09:00", "system": "cabin", "status": "closed", "note": ""},
    ]
    rows = query("open_defects", "PDX", tables=with_rows(aircraft=[aircraft("N1")], defects=log))
    assert [(r["defect"], r["status"]) for r in rows] == [("D-2", "deferred")]
