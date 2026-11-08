import sluice
from meterbill import billing, sample
from meterbill.job import run_nightly


def test_running_the_night_again_doesnt_bill_twice():
    store, readings = sluice.Store(), sample.readings(accounts=["R-100", "R-101", "B-300"])
    run_nightly(readings, store, sample.DAY)
    once = billing.bills(store, sample.DAY)
    run_nightly(readings, store, sample.DAY)   # operations re-runs the night
    assert billing.bills(store, sample.DAY) == once, "a re-run changed the bills"
