"""Grading tests for the Palantir FDSE learning round. Kept out of the candidate workspace."""
import inspect
import threading
import time

import pytest

import relay
from supplysync import sample
from supplysync.client import HospitalAPI
from supplysync.sync import pull_all, run_sync


def call(api, hospitals=None, **options):
    """pull_all with the options this part added, failing clearly when the part isn't written yet."""
    accepted = inspect.signature(pull_all).parameters
    for name in options:
        if name not in accepted:
            pytest.fail(f"pull_all doesn't take {name}= yet")
    return pull_all(api, sample.HOSPITALS if hospitals is None else hospitals, **options)


def within(seconds, function):
    """Runs function in a thread and fails if it takes longer than seconds."""
    result, error = [], []

    def run():
        try:
            result.append(function())
        except BaseException as caught:
            error.append(caught)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), f"took longer than {seconds} seconds"
    if error:
        raise error[0]
    return result[0]


# Part 1: parallel

def test_same_items_as_before():
    assert call(HospitalAPI(sample.inventories(), latency=0.002)).stock == sample.inventories()


def test_the_report_still_works():
    report = run_sync(HospitalAPI(sample.inventories(), latency=0.002), sample.HOSPITALS, sample.PAR_LEVELS)
    assert len(report.low_stock) == 20 and report.low_stock[0].sku == "IV-1L"


def test_no_hospitals():
    pull = call(HospitalAPI(sample.inventories(), latency=0.002), [])
    assert pull.stock == {} and pull.missing == [] and pull.late == []


def test_hospitals_are_pulled_in_parallel():
    api = HospitalAPI(sample.inventories(), latency=0.03)
    call(api)
    assert api.max_in_flight > 1


def test_never_more_than_four_requests_at_once():
    api = HospitalAPI(sample.inventories(), page_size=2, latency=0.02)
    call(api)
    assert api.max_in_flight <= 4


def test_one_request_at_a_time_per_hospital():
    api = HospitalAPI(sample.inventories(), page_size=1, latency=0.01)
    assert call(api).stock == sample.inventories()
    assert api.max_per_hospital == 1


def test_much_faster_than_one_at_a_time():
    api = HospitalAPI(sample.inventories(), latency=0.05)   # one at a time: 18 requests, about 0.9 seconds
    start = time.monotonic()
    call(api)
    assert time.monotonic() - start < 0.6


# Part 2: failures

def test_a_dropped_connection_is_retried():
    api = HospitalAPI(sample.inventories(), latency=0.003, drops={"cedar": [2]})
    pull = call(api)
    assert pull.stock["cedar"] == sample.inventories()["cedar"] and pull.missing == []


def test_two_dropped_connections_still_succeed_on_the_third_try():
    api = HospitalAPI(sample.inventories(), latency=0.003, drops={"cedar": [1, 2]})
    assert call(api).stock["cedar"] == sample.inventories()["cedar"]


def test_three_tries_at_most_then_missing():
    api = HospitalAPI(sample.inventories(), latency=0.003, drops={"cedar": range(1, 20)})
    pull = call(api)
    assert pull.missing == ["cedar"] and "cedar" not in pull.stock
    assert max(count for (hospital, _), count in api.attempts.items() if hospital == "cedar") == 3


def test_an_offline_hospital_is_not_retried():
    api = HospitalAPI(sample.inventories(), latency=0.003, offline=["harbor"])
    pull = call(api)
    assert pull.missing == ["harbor"] and api.attempts[("harbor", 0)] == 1


def test_the_other_hospitals_still_make_it():
    api = HospitalAPI(sample.inventories(), latency=0.003, offline=["harbor", "brook"], drops={"maple": range(1, 20)})
    pull = call(api)
    assert pull.missing == ["brook", "harbor", "maple"]
    assert sorted(pull.stock) == ["cedar", "lakeside", "summit"]


def test_other_errors_fail_the_sync():
    api = HospitalAPI(sample.inventories(), latency=0.003, broken=["maple"])
    with pytest.raises((ValueError, relay.JobFailed)):
        call(api)


# Part 3: deadline

def test_a_slow_hospital_is_late():
    api = HospitalAPI(sample.inventories(), latency=0.003, slow={"summit": 0.25})
    pull = call(api, deadline=0.4)
    assert pull.late == ["summit"] and "summit" not in pull.stock and len(pull.stock) == 5


def test_a_late_hospital_gets_no_more_requests():
    api = HospitalAPI(sample.inventories(), page_size=2, latency=0.003, slow={"summit": 0.15})
    call(api, deadline=0.3)
    assert not [r for r in api.requests if r[0] == "summit" and r[2] > 0.35]


def test_no_deadline_waits_for_everyone():
    api = HospitalAPI(sample.inventories(), latency=0.003, slow={"summit": 0.05})
    pull = call(api, deadline=None)
    assert pull.late == [] and pull.stock == sample.inventories()


def test_late_and_missing_together():
    api = HospitalAPI(sample.inventories(), latency=0.003, slow={"summit": 0.25, "brook": 0.25}, offline=["harbor"])
    pull = call(api, deadline=0.4)
    assert pull.late == ["brook", "summit"] and pull.missing == ["harbor"] and sorted(pull.stock) == ["cedar", "lakeside", "maple"]


def test_the_deadline_is_kept():
    api = HospitalAPI(sample.inventories(), latency=0.003, slow={"summit": 0.3})   # summit alone takes about 0.9 seconds
    within(0.4 + 0.3 + 0.25, lambda: call(api, deadline=0.4))


# Part 4: progress

def test_progress_counts_every_hospital():
    api = HospitalAPI(sample.inventories(), latency=0.003, offline=["harbor"])
    calls = []
    call(api, on_progress=lambda done, total: calls.append((done, total)))
    assert sorted(done for done, _ in calls) == [1, 2, 3, 4, 5, 6] and {total for _, total in calls} == {6}


def test_progress_comes_while_the_sync_runs():
    api = HospitalAPI(sample.inventories(), latency=0.003, slow={"summit": 0.15})
    calls, start = [], time.monotonic()
    call(api, on_progress=lambda done, total: calls.append(time.monotonic() - start))
    assert len(calls) == 6 and min(calls) < 0.3


def test_late_hospitals_dont_count():
    api = HospitalAPI(sample.inventories(), latency=0.003, slow={"summit": 0.25})
    calls = []
    call(api, deadline=0.4, on_progress=lambda done, total: calls.append(done))
    assert sorted(calls) == [1, 2, 3, 4, 5]
