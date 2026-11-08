import sluice
from meterbill import billing, sample
from meterbill.job import run_nightly


def test_the_warehouse_gets_its_whole_day():
    store, readings = sluice.Store(), sample.readings()
    run_nightly(readings, store, sample.DAY)
    expected = sample.meter_totals(readings)["C-200"]   # about 2,055 kWh
    assert billing.usage_for(store, "C-200", sample.DAY) == expected
    assert billing.bill_for(store, "C-200", sample.DAY) == round(expected * 0.21 + 0.40, 2)
