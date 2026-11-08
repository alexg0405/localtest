import sluice
from meterbill import billing, sample
from meterbill.job import run_nightly

SMALL = ["R-100", "R-101", "B-300"]   # a quiet corner of the network: one batch


def test_each_account_gets_its_usage_for_the_day():
    store, readings = sluice.Store(), sample.readings(accounts=SMALL)
    run_nightly(readings, store, sample.DAY)
    totals = sample.meter_totals(readings)
    assert {row["account"]: row["kwh"] for row in store.table("daily_usage").rows()} == totals
    assert billing.usage_for(store, "R-101", sample.DAY) == totals["R-101"]
    assert store.table("daily_usage").find(account="R-101")[0]["readings"] == 90


def test_each_account_is_charged_for_its_usage():
    store = sluice.Store()
    reports = run_nightly(sample.readings(accounts=SMALL), store, sample.DAY)
    assert billing.bill_for(store, "R-100", sample.DAY) == round(21.0 * 0.21 + 0.40, 2)
    assert sorted(billing.bills(store, sample.DAY)) == sorted(SMALL)
    assert reports["daily_usage"].read == 377 and reports["charges"].written == 3
