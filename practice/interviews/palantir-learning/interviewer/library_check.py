"""relay against its docs: run in a workspace, it prints "ok" or fails with what's wrong (verify runs it)."""
import threading, time
import relay

def slow(n):
    time.sleep(0.05)
    return n

with relay.Runner(workers=1) as runner:
    handles = [runner.submit(slow, i) for i in range(3)]
    time.sleep(0.02)   # the first one starts; the other two are still queued when the block ends
assert handles[0].result() == 0 and all(h.state == "cancelled" for h in handles[1:]), "the with block cancels queued jobs"

def boom():
    raise ValueError("bad")

with relay.Runner() as runner:
    handle = runner.submit(boom)
    try:
        handle.result()
        raise AssertionError("result() should raise")
    except relay.JobFailed as failed:
        assert isinstance(failed.cause, ValueError), "JobFailed carries the cause"

running, peak, lock = [0], [0], threading.Lock()
def tracked():
    with lock:
        running[0] += 1
        peak[0] = max(peak[0], running[0])
    time.sleep(0.03)
    with lock:
        running[0] -= 1

with relay.Runner(workers=4) as runner:
    relay.gather([runner.submit(tracked, key="same") for _ in range(3)])
assert peak[0] == 1, "jobs with the same key run one at a time"

with relay.Runner(workers=2) as runner:
    first, second = runner.submit(time.sleep, 0.15), runner.submit(time.sleep, 0.01)
    assert [o.handle for o in relay.gather([first, second])] == [second, first], "gather returns outcomes in finishing order"

calls = [0]
def flaky():
    calls[0] += 1
    raise ConnectionError("dropped")

with relay.Runner() as runner:
    handle = runner.submit(flaky, retry=relay.Retry(times=2, wait=0.001))
    relay.gather([handle])
assert calls[0] == 3 and handle.attempts == 3, "Retry(times=2) runs the job three times"

def patient():
    for _ in range(100):
        if relay.cancelled():
            raise relay.Cancelled("stopped")
        time.sleep(0.01)
    return "finished"

with relay.Runner() as runner:
    handle = runner.submit(patient)
    outcome = relay.gather([handle], timeout=0.05)[0]
assert not outcome.ok and isinstance(outcome.error, relay.Cancelled) and handle.state == "cancelled", "a timeout cancels a job that checks"
print("ok")
