from supplysync import sample
from supplysync.client import HospitalAPI
from supplysync.sync import pull_all, run_sync


def test_pulls_every_item_from_every_hospital():
    pull = pull_all(HospitalAPI(sample.inventories(), latency=0.001), sample.HOSPITALS)
    assert pull.stock == sample.inventories() and pull.missing == [] and pull.late == []


def test_the_report_lists_items_below_par_most_short_first():
    report = run_sync(HospitalAPI(sample.inventories(), latency=0.001), sample.HOSPITALS, sample.PAR_LEVELS)
    assert [(s.hospital, s.sku) for s in report.low_stock[:3]] == [("summit", "IV-1L"), ("cedar", "N95"), ("cedar", "SYR-10")]
    assert all(s.on_hand < s.par for s in report.low_stock)
