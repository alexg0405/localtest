from supplysync import sample
from supplysync.client import HospitalAPI
from supplysync.sync import pull_all


def test_pulls_the_hospitals_at_the_same_time():
    api = HospitalAPI(sample.inventories(), latency=0.03)
    pull = pull_all(api, sample.HOSPITALS)
    assert pull.stock == sample.inventories()
    assert api.max_in_flight > 1, "the hospitals were pulled one at a time"
    assert api.max_in_flight <= 4, f"{api.max_in_flight} requests were in flight at once; the VPN takes 4"
    assert api.max_per_hospital == 1
