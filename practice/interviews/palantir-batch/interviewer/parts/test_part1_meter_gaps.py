import sluice
from meterbill import sample
from meterbill.job import meter_gaps


def test_meters_that_missed_readings_are_listed():
    store = sluice.Store()
    meter_gaps(sample.readings(accounts=["R-100", "R-101", "B-300"]), store, sample.DAY)
    rows = sorted(store.table("meter_gaps").rows(), key=lambda row: row["meter"])
    assert rows == [
        {"meter": "M-1010", "account": "R-101", "day": sample.DAY, "readings": 90, "missing": 6},
        {"meter": "M-3001", "account": "B-300", "day": sample.DAY, "readings": 95, "missing": 1},
    ]
