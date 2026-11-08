import sluice
from meterbill import billing, sample
from meterbill.job import run_nightly


def test_a_bad_reading_is_listed_and_the_night_goes_on():
    store, readings = sluice.Store(), sample.readings()
    bad = next(i for i, reading in enumerate(readings) if reading["meter"] == "M-1040" and reading["ts"].endswith("T07:30"))
    readings[bad] = {**readings[bad], "wh": "ERR"}
    run_nightly(readings, store, sample.DAY)   # no exception
    assert len(store.table("daily_usage").find(day=sample.DAY)) == 11, "every account still gets its usage"
    assert billing.usage_for(store, "R-104", sample.DAY) == sample.meter_totals(readings)["R-104"]
    [row] = store.table("bad_readings").rows()
    assert (row["meter"], row["account"], row["ts"], row["wh"]) == ("M-1040", "R-104", sample.DAY + "T07:30", "ERR")
    assert isinstance(row["error"], str) and row["error"]
