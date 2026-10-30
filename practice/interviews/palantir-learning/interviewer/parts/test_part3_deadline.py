from supplysync import sample
from supplysync.client import HospitalAPI
from supplysync.sync import pull_all


def test_a_hospital_that_runs_past_the_deadline_is_late():
    api = HospitalAPI(sample.inventories(), latency=0.005, slow={"summit": 0.25})
    pull = pull_all(api, sample.HOSPITALS, deadline=0.4)
    assert pull.late == ["summit"] and "summit" not in pull.stock
    assert len(pull.stock) == 5
    after = [request for request in api.requests if request[0] == "summit" and request[2] > 0.45]
    assert not after, f"summit got {len(after)} request(s) after the deadline"
