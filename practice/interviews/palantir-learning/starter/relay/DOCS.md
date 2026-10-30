# relay

relay runs many small jobs at once on a few worker threads. Our deployment
teams use it for syncs that call slow customer systems: it adds the parts
that a plain thread pool leaves to you, such as one-at-a-time keys, retries,
and timeouts.

It is an internal library shared by several deployments. Use it as it is.

## Contents

1. The basics
2. Handles
3. Keys
4. Waiting for many jobs: `gather`
5. Retries
6. Cancellation and timeouts
7. Callbacks and `Tally`
8. Exceptions

## 1. The basics

```python
import relay

def double(n):
    return n * 2

with relay.Runner(workers=4) as runner:
    handle = runner.submit(double, 21)
    print(handle.result())   # 42
```

- `relay.Runner(workers=4)` starts 4 worker threads. A job is any function;
  each one runs on a worker thread.
- `runner.submit(fn, *args, **kwargs)` queues `fn(*args, **kwargs)` and
  returns a **Handle** right away. The job starts when a worker is free.
- Use the runner as a context manager. **When the `with` block ends, relay
  waits for the jobs that are already running, but cancels every job that is
  still queued: those never run.** Wait for your jobs (with `result()` or
  `gather`) inside the block.
- After the block, the runner is closed, and `submit` raises `RuntimeError`.
  The handles still work: you can read their results after the block.

`submit` takes two keywords of its own, `key` (section 3) and `retry`
(section 5), so your function can't use those names. Every other keyword goes
to your function.

## 2. Handles

A Handle is one submitted job.

| | |
|---|---|
| `handle.result(timeout=None)` | Waits for the job and returns its value. If the job raised, raises **`relay.JobFailed`**, with the job's own exception in `.cause`. If the job was cancelled, raises `relay.Cancelled`. If `timeout` seconds pass first, raises `TimeoutError` (the job keeps going). |
| `handle.state` | `"queued"`, `"running"`, `"done"`, `"failed"`, or `"cancelled"`. |
| `handle.done()` | True once the state is `done`, `failed`, or `cancelled`. |
| `handle.cancel()` | Cancels the job. See section 6. |
| `handle.key` | The key it was submitted with, or None. |
| `handle.attempts` | How many times the function has started (more than 1 after retries). |

```python
def parse(text):
    return int(text)

with relay.Runner() as runner:
    handle = runner.submit(parse, "not a number")
    try:
        handle.result()
    except relay.JobFailed as failure:
        print(type(failure.cause))   # <class 'ValueError'>
```

Note that `result()` never raises the job's own exception type, so
`except ValueError:` around `result()` catches nothing. Catch `JobFailed` and
look at `.cause`.

Handles are hashable, so you can use them as dictionary keys to remember
which job was which.

## 3. Keys

Jobs submitted with the same **key** run one at a time, in the order you
submitted them, even when workers are free. Jobs with different keys (or no
key) run in parallel, up to the number of workers.

```python
with relay.Runner(workers=4) as runner:
    a = runner.submit(save, "row 1", key="ledger")
    b = runner.submit(save, "row 2", key="ledger")   # starts after a finishes
    c = runner.submit(save, "row 3", key="audit")    # runs alongside a
```

Keys are for systems that can't take two requests at once. A key can be any
hashable value.

To let up to `n` jobs with one key run at once, call `runner.limit(key, n)`
before you submit them. Without a limit, it's 1.

A job that waits for another job's result with the same key, from inside a
job, waits forever: the second job can't start until the first finishes.

## 4. Waiting for many jobs: `gather`

```python
outcomes = relay.gather(handles, timeout=None)
```

`gather` waits for every handle in the list and returns a list of
**Outcome** objects, one per handle, **in the order the jobs finished**, not
the order of the list you passed.

| | |
|---|---|
| `outcome.handle` | The handle it's about. |
| `outcome.ok` | True if the job finished without raising. |
| `outcome.value` | What the job returned (None unless `ok`). |
| `outcome.error` | The exception the job raised, as it was raised (not wrapped in `JobFailed`), or a `relay.Cancelled` if the job was cancelled. None if `ok`. |

`gather` never raises because a job failed: check each outcome.

With a `timeout` in seconds, `gather` stops waiting when it runs out and
cancels the jobs that haven't finished (see section 6). It returns straight
away; those jobs come back as outcomes with `ok=False` and a
`relay.Cancelled` error, after the ones that finished.

## 5. Retries

```python
handle = runner.submit(fetch, url, retry=relay.Retry(times=2, on=(ConnectionError,), wait=0.05))
```

If the job raises one of the exceptions in `on` (or a subclass), relay runs
it again, up to **`times` more times**: with `times=2`, the function runs at
most 3 times in all. Each run starts the function from the beginning. relay
waits `wait` seconds before the first retry and doubles the wait each time.

Exceptions that aren't in `on` fail the job straight away, with no retry.
When the last try fails, the job fails with that exception.

While it waits between tries, the job keeps its worker and its key. Its
state stays `"running"`.

The defaults are `Retry(times=2, on=(ConnectionError,), wait=0.05)`.

## 6. Cancellation and timeouts

`handle.cancel()`:

- A **queued** job is dropped: it never runs, its state becomes
  `"cancelled"`, and `cancel()` returns True.
- A **running** job can't be stopped from outside, because Python threads
  can't be interrupted. relay asks it to stop instead, and `cancel()` returns
  False. Inside the job, `relay.cancelled()` now returns True. A long job
  should check it between steps and stop:

```python
def copy_rows(rows):
    for row in rows:
        if relay.cancelled():
            raise relay.Cancelled("stopped early")
        write(row)
```

Once a job has been asked to stop, its state ends up `"cancelled"` however
it finishes, and anything it returns is thrown away.

- A job that has already finished isn't affected, and `cancel()` returns
  False.

`gather(handles, timeout=...)` cancels the unfinished jobs this way when its
time runs out. The `with` block cancels queued jobs the same way when it ends
(section 1). Retries stop once a job has been cancelled.

## 7. Callbacks and `Tally`

```python
def finished(handle):
    print(handle.key, handle.state)

with relay.Runner() as runner:
    runner.on_finish(finished)
    ...
```

`runner.on_finish(fn)` calls `fn(handle)` every time one of the runner's
jobs reaches `done`, `failed`, or `cancelled`. It's called on the thread
that finished the job: usually a worker, so **callbacks for different jobs
can run at the same time**. Protect anything they share with a
`threading.Lock`, or use `relay.Tally` for counts. If a callback raises, relay
prints the error and carries on.

`relay.Tally()` is a counter that's safe to update from several threads:
`tally.add(1)` adds one and returns the new total, and `tally.value` reads it.

## 8. Exceptions

| | |
|---|---|
| `relay.JobFailed` | Raised by `result()` when the job raised. `.cause` is the job's exception. |
| `relay.Cancelled` | The job was cancelled. Raised by `result()`, found in `outcome.error`, and raised by jobs that stop early. |
| `TimeoutError` | Raised by `result(timeout=...)` when the job isn't finished in time. |
| `RuntimeError` | Raised by `submit` after the runner has closed. |
