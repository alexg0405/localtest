import time

from supplysync import sample
from supplysync.client import HospitalAPI
from supplysync.sync import pull_all


def test_progress_is_reported_while_the_sync_runs():
    api = HospitalAPI(sample.inventories(), latency=0.005, slow={"summit": 0.15}, offline=["harbor"])
    calls, start = [], time.monotonic()
    pull_all(api, sample.HOSPITALS, on_progress=lambda done, total: calls.append((done, total, time.monotonic() - start)))
    assert sorted(done for done, _, _ in calls) == [1, 2, 3, 4, 5, 6] and {total for _, total, _ in calls} == {6}
    assert min(at for _, _, at in calls) < 0.3, "progress only came at the end"   # summit alone takes about 0.45 seconds
