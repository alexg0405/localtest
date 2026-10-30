from supplysync import sample
from supplysync.client import HospitalAPI
from supplysync.sync import pull_all


def test_a_dropped_connection_is_retried_and_an_offline_hospital_is_missing():
    api = HospitalAPI(sample.inventories(), latency=0.005, drops={"cedar": [2]}, offline=["harbor"])
    pull = pull_all(api, sample.HOSPITALS)
    assert pull.missing == ["harbor"]
    assert pull.stock["cedar"] == sample.inventories()["cedar"]
    assert sorted(pull.stock) == sorted(h for h in sample.HOSPITALS if h != "harbor")
