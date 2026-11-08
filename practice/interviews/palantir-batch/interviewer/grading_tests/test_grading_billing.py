"""Grading tests for the Palantir FDSE learning round on sluice. Kept out of the candidate workspace."""
import pytest

import sluice
from meterbill import billing, sample
from meterbill.job import meter_gaps, run_nightly

SMALL = ["R-100", "R-101", "B-300"]   # fits in one batch
WHOLE_NIGHT = 10_000                  # a batch size that fits the whole sample night in one batch


def price(kwh):
    return round(kwh * 0.21 + 0.40, 2)


def usage(store, day=sample.DAY):
    return {row["account"]: row["kwh"] for row in store.table("daily_usage").find(day=day)}


def gaps(store):
    return {row["meter"]: (row["account"], row["day"], row["readings"], row["missing"]) for row in store.table("meter_gaps").rows()}


def spoil(readings, meter, time, wh):
    """The readings with one of `meter`'s readings changed to `wh` (None drops the field)."""
    out = list(readings)
    i = next(i for i, reading in enumerate(out) if reading["meter"] == meter and reading["ts"].endswith("T" + time))
    out[i] = {k: v for k, v in out[i].items() if k != "wh"} if wh is None else {**out[i], "wh": wh}
    return out


# The job as it was

def test_usage_for_a_quiet_night():
    store, readings = sluice.Store(), sample.readings(accounts=SMALL)
    run_nightly(readings, store, sample.DAY)
    assert usage(store) == sample.meter_totals(readings)
    assert {row["account"]: row["readings"] for row in store.table("daily_usage").rows()} == {"R-100": 96, "R-101": 90, "B-300": 191}


def test_charges_are_priced_at_the_tariff():
    store, readings = sluice.Store(), sample.readings(accounts=SMALL)
    run_nightly(readings, store, sample.DAY)
    totals = sample.meter_totals(readings)
    assert billing.bills(store, sample.DAY) == {account: price(kwh) for account, kwh in totals.items()}


def test_an_empty_night_writes_nothing():
    store = sluice.Store()
    run_nightly([], store, sample.DAY)
    assert store.table("daily_usage").rows() == [] and store.table("charges").rows() == []


def test_a_night_with_one_reading():
    store = sluice.Store()
    run_nightly([{"meter": "M-1000", "account": "R-100", "ts": sample.DAY + "T00:00", "wh": "250"}], store, sample.DAY)
    assert store.table("daily_usage").rows() == [{"account": "R-100", "day": sample.DAY, "kwh": 0.25, "readings": 1}]
    assert billing.bill_for(store, "R-100", sample.DAY) == price(0.25)


# Part 1: meter gaps

def test_healthy_meters_are_not_listed():
    store = sluice.Store()
    meter_gaps(sample.readings(gaps=False), store, sample.DAY, batch_size=WHOLE_NIGHT)
    assert store.table("meter_gaps").rows() == []


def test_every_short_meter_on_the_night_is_listed():
    store = sluice.Store()
    meter_gaps(sample.readings(), store, sample.DAY, batch_size=WHOLE_NIGHT)
    assert gaps(store) == {"M-1010": ("R-101", sample.DAY, 90, 6), "M-3001": ("B-300", sample.DAY, 95, 1),
                           "M-2003": ("C-200", sample.DAY, 76, 20), "M-1060": ("R-106", sample.DAY, 90, 6)}


def test_the_nightly_run_finds_meter_gaps():
    store = sluice.Store()
    reports = run_nightly(sample.readings(accounts=SMALL), store, sample.DAY)
    assert "meter_gaps" in reports and isinstance(reports["meter_gaps"], sluice.RunReport)
    assert sorted(gaps(store)) == ["M-1010", "M-3001"]


def test_a_reading_that_wont_parse_still_counts():
    store = sluice.Store()
    meter_gaps(spoil(sample.readings(accounts=SMALL), "M-1000", "03:00", "ERR"), store, sample.DAY, batch_size=WHOLE_NIGHT)
    assert "M-1000" not in gaps(store), "the meter reported: a reading that won't parse is still a reading"


# Part 2: re-runs

def test_a_rerun_doesnt_charge_twice():
    store, readings = sluice.Store(), sample.readings(accounts=SMALL)
    run_nightly(readings, store, sample.DAY)
    run_nightly(readings, store, sample.DAY)
    assert len(store.table("charges").find(day=sample.DAY)) == 3
    assert billing.bills(store, sample.DAY) == {account: price(kwh) for account, kwh in sample.meter_totals(readings).items()}


def test_a_rerun_leaves_usage_as_it_was():
    store, readings = sluice.Store(), sample.readings(accounts=SMALL)
    run_nightly(readings, store, sample.DAY)
    before = store.table("daily_usage").rows()
    run_nightly(readings, store, sample.DAY)
    assert store.table("daily_usage").rows() == before


def test_each_day_keeps_its_own_charges():
    store = sluice.Store()
    run_nightly(sample.readings(sample.DAY, accounts=SMALL), store, sample.DAY)
    run_nightly(sample.readings(sample.NEXT_DAY, accounts=SMALL, gaps=False), store, sample.NEXT_DAY)
    run_nightly(sample.readings(sample.DAY, accounts=SMALL), store, sample.DAY)   # Monday re-run on Tuesday
    assert len(store.table("charges").rows()) == 6
    assert billing.bill_for(store, "R-101", sample.DAY) == price(sample.meter_totals(sample.readings(accounts=["R-101"]))["R-101"])
    assert billing.bill_for(store, "R-101", sample.NEXT_DAY) == price(sample.meter_totals(sample.readings(sample.NEXT_DAY, accounts=["R-101"], gaps=False))["R-101"])


def test_a_rerun_with_late_readings_updates_the_bill():
    store = sluice.Store()
    run_nightly(sample.readings(accounts=SMALL), store, sample.DAY)
    complete = sample.readings(accounts=SMALL, gaps=False)   # the missing readings arrived late, and the night is re-run
    run_nightly(complete, store, sample.DAY)
    assert billing.bill_for(store, "R-101", sample.DAY) == price(sample.meter_totals(complete)["R-101"])
    assert len(store.table("charges").find(account="R-101", day=sample.DAY)) == 1


# Part 3: whole-day totals

def test_the_biggest_accounts_get_their_whole_day():
    store, readings = sluice.Store(), sample.readings()
    run_nightly(readings, store, sample.DAY)
    totals = sample.meter_totals(readings)
    assert usage(store)["C-200"] == totals["C-200"] and usage(store)["C-201"] == totals["C-201"]
    assert store.table("daily_usage").find(account="C-200")[0]["readings"] == 556


@pytest.mark.parametrize("batch_size", [7, 96, 500, 5000])
def test_every_account_matches_its_meters_at_any_batch_size(batch_size):
    store, readings = sluice.Store(), sample.readings()
    run_nightly(readings, store, sample.DAY, batch_size=batch_size)
    assert usage(store) == sample.meter_totals(readings)
    assert len(store.table("daily_usage").rows()) == 11


def test_bills_follow_the_whole_days_usage():
    store, readings = sluice.Store(), sample.readings()
    run_nightly(readings, store, sample.DAY, batch_size=50)
    totals = sample.meter_totals(readings)
    assert billing.bills(store, sample.DAY) == {account: price(kwh) for account, kwh in sorted(totals.items())}


def test_meter_gaps_are_right_across_batches():
    store = sluice.Store()
    meter_gaps(sample.readings(), store, sample.DAY, batch_size=50)
    assert gaps(store) == {"M-1010": ("R-101", sample.DAY, 90, 6), "M-3001": ("B-300", sample.DAY, 95, 1),
                           "M-2003": ("C-200", sample.DAY, 76, 20), "M-1060": ("R-106", sample.DAY, 90, 6)}


# Part 4: bad readings

def test_a_bad_reading_doesnt_stop_the_night():
    store, readings = sluice.Store(), spoil(sample.readings(), "M-2001", "12:00", "ERR")
    run_nightly(readings, store, sample.DAY)
    assert len(billing.bills(store, sample.DAY)) == 11


def test_bad_readings_are_listed_for_the_metering_team():
    store, readings = sluice.Store(), spoil(spoil(sample.readings(), "M-2001", "12:00", "ERR"), "M-1050", "23:45", "")
    run_nightly(readings, store, sample.DAY)
    rows = sorted(store.table("bad_readings").rows(), key=lambda row: row["meter"])
    assert [(r["meter"], r["account"], r["ts"], r["wh"]) for r in rows] == [
        ("M-1050", "R-105", sample.DAY + "T23:45", ""), ("M-2001", "C-200", sample.DAY + "T12:00", "ERR")]
    assert all(isinstance(r["error"], str) and r["error"] for r in rows)


def test_negative_and_missing_readings_are_bad_too():
    store = sluice.Store()
    readings = spoil(spoil(sample.readings(accounts=SMALL), "M-1000", "01:00", "-40"), "M-3000", "02:00", None)
    run_nightly(readings, store, sample.DAY)
    assert sorted(r["meter"] for r in store.table("bad_readings").rows()) == ["M-1000", "M-3000"]
    assert len(store.table("daily_usage").rows()) == 3


def test_an_account_with_a_bad_reading_is_billed_for_the_rest():
    store, readings = sluice.Store(), spoil(sample.readings(accounts=SMALL), "M-1000", "09:15", "ERR")
    run_nightly(readings, store, sample.DAY)
    assert billing.usage_for(store, "R-100", sample.DAY) == sample.meter_totals(readings)["R-100"]
    assert store.table("daily_usage").find(account="R-100")[0]["readings"] == 95


def test_a_rerun_lists_a_bad_reading_once():
    store, readings = sluice.Store(), spoil(sample.readings(accounts=SMALL), "M-1000", "09:15", "ERR")
    run_nightly(readings, store, sample.DAY)
    run_nightly(readings, store, sample.DAY)
    assert len(store.table("bad_readings").rows()) == 1


def test_a_clean_night_lists_no_bad_readings():
    store = sluice.Store()
    run_nightly(sample.readings(accounts=SMALL), store, sample.DAY)
    assert store.table("bad_readings").rows() == []
