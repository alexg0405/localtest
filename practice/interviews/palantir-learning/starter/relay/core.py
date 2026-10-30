"""relay's implementation. DOCS.md describes how to use it; you shouldn't need to read this file."""
from __future__ import annotations

import itertools
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Type

_local = threading.local()
_finish_order = itertools.count(1)


class Cancelled(Exception):
    """The job was cancelled before it finished."""

    def __init__(self, why: str = "the job was cancelled"):
        super().__init__(why)


class JobFailed(Exception):
    """Raised by Handle.result() when the job raised. The job's own exception is in .cause."""

    def __init__(self, cause: BaseException):
        super().__init__(f"the job raised {type(cause).__name__}: {cause}")
        self.cause = cause


@dataclass(frozen=True)
class Retry:
    """Run a job again when it raises one of `on`, up to `times` more times."""

    times: int = 2
    on: Tuple[Type[BaseException], ...] = (ConnectionError,)
    wait: float = 0.05


@dataclass(frozen=True)
class Outcome:
    """How one job ended, as gather reports it."""

    handle: "Handle"
    ok: bool
    value: Any = None
    error: Optional[BaseException] = None


class Tally:
    """A counter that's safe to change from several threads at once."""

    def __init__(self, start: int = 0):
        self._value = start
        self._lock = threading.Lock()

    def add(self, n: int = 1) -> int:
        """Adds n and returns the new total."""
        with self._lock:
            self._value += n
            return self._value

    @property
    def value(self) -> int:
        with self._lock:
            return self._value


def cancelled() -> bool:
    """Inside a job: True once the job has been cancelled. Outside a job: always False."""
    handle = getattr(_local, "handle", None)
    return handle is not None and handle._stop.is_set()


class Handle:
    """A job you submitted. Runner.submit makes these; you don't create them yourself."""

    def __init__(self, runner: "Runner", fn: Callable[..., Any], args: tuple, kwargs: dict, key: Any, retry: Optional[Retry]):
        self._runner, self._fn, self._args, self._kwargs, self._retry = runner, fn, args, kwargs, retry
        self.key = key
        self.state = "queued"
        self.attempts = 0
        self._value: Any = None
        self._error: Optional[BaseException] = None
        self._done = threading.Event()
        self._stop = threading.Event()
        self._order = 0

    def __repr__(self) -> str:
        return f"<relay.Handle {getattr(self._fn, '__name__', 'job')}{self._args!r} key={self.key!r} {self.state}>"

    def done(self) -> bool:
        return self._done.is_set()

    def result(self, timeout: Optional[float] = None) -> Any:
        if not self._done.wait(timeout):
            raise TimeoutError(f"the job is still {self.state} after {timeout} seconds")
        if self.state == "cancelled":
            raise self._error if isinstance(self._error, Cancelled) else Cancelled()
        if self.state == "failed":
            raise JobFailed(self._error)
        return self._value

    def cancel(self) -> bool:
        return self._runner._cancel(self)


class Runner:
    """Runs submitted jobs on `workers` threads. Use it as a context manager."""

    def __init__(self, workers: int = 4):
        if workers < 1:
            raise ValueError("a Runner needs at least one worker")
        self._lock = threading.Condition()
        self._queue: List[Handle] = []
        self._running: Dict[Any, int] = {}
        self._limits: Dict[Any, int] = {}
        self._callbacks: List[Callable[[Handle], None]] = []
        self._closed = False
        self._threads = [threading.Thread(target=self._work, name=f"relay-worker-{i + 1}", daemon=True) for i in range(workers)]
        for thread in self._threads:
            thread.start()

    def __enter__(self) -> "Runner":
        return self

    def __exit__(self, *exc: Any) -> bool:
        self.close()
        return False

    def submit(self, fn: Callable[..., Any], *args: Any, key: Any = None, retry: Optional[Retry] = None, **kwargs: Any) -> Handle:
        handle = Handle(self, fn, args, kwargs, key, retry)
        with self._lock:
            if self._closed:
                raise RuntimeError("this Runner is closed: submit jobs inside its with block")
            self._queue.append(handle)
            self._lock.notify_all()
        return handle

    def limit(self, key: Any, n: int) -> None:
        if n < 1:
            raise ValueError("a key's limit must be at least 1")
        with self._lock:
            self._limits[key] = n
            self._lock.notify_all()

    def on_finish(self, fn: Callable[[Handle], None]) -> Callable[[Handle], None]:
        with self._lock:
            self._callbacks.append(fn)
        return fn

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            dropped, self._queue = self._queue, []
            self._lock.notify_all()
        for handle in dropped:
            self._finish(handle, "cancelled", None, Cancelled("the job was still queued when the Runner closed"))
        for thread in self._threads:
            thread.join()

    # Workers

    def _runnable(self, handle: Handle) -> bool:
        return handle.key is None or self._running.get(handle.key, 0) < self._limits.get(handle.key, 1)

    def _next(self) -> Optional[Handle]:
        with self._lock:
            while True:
                for i, handle in enumerate(self._queue):
                    if self._runnable(handle):
                        del self._queue[i]
                        handle.state = "running"
                        if handle.key is not None:
                            self._running[handle.key] = self._running.get(handle.key, 0) + 1
                        return handle
                if self._closed:
                    return None
                self._lock.wait()

    def _work(self) -> None:
        while True:
            handle = self._next()
            if handle is None:
                return
            self._run(handle)

    def _run(self, handle: Handle) -> None:
        state, value, error = "done", None, None
        _local.handle = handle
        try:
            while True:
                handle.attempts += 1
                try:
                    value = handle._fn(*handle._args, **handle._kwargs)
                    break
                except Cancelled as caught:
                    state, error = "cancelled", caught
                    break
                except Exception as caught:  # noqa: BLE001 - a job's failure is its result
                    retry = handle._retry
                    if retry and isinstance(caught, retry.on) and handle.attempts <= retry.times and not handle._stop.is_set():
                        handle._stop.wait(retry.wait * 2 ** (handle.attempts - 1))
                        if not handle._stop.is_set():
                            continue
                    state, error = "failed", caught
                    break
        finally:
            _local.handle = None
            with self._lock:
                if handle.key is not None:
                    self._running[handle.key] -= 1
                self._lock.notify_all()
        if handle._stop.is_set():
            state, value, error = "cancelled", None, Cancelled("the job was cancelled while it ran")
        self._finish(handle, state, value, error)

    def _finish(self, handle: Handle, state: str, value: Any, error: Optional[BaseException]) -> None:
        with self._lock:
            if handle._done.is_set():
                return
            handle.state, handle._value, handle._error = state, value, error
            handle._order = next(_finish_order)
            callbacks = list(self._callbacks)
        handle._done.set()
        for callback in callbacks:
            try:
                callback(handle)
            except Exception:  # noqa: BLE001 - a broken callback mustn't take a worker down
                traceback.print_exc()

    def _cancel(self, handle: Handle) -> bool:
        with self._lock:
            if handle._done.is_set():
                return False
            queued = any(waiting is handle for waiting in self._queue)
            if queued:
                self._queue = [waiting for waiting in self._queue if waiting is not handle]
            else:
                handle._stop.set()
        if queued:
            self._finish(handle, "cancelled", None, Cancelled("the job was cancelled before it started"))
        return queued


def gather(handles: Iterable[Handle], timeout: Optional[float] = None) -> List[Outcome]:
    """Waits for the jobs and returns one Outcome each, in the order they finished."""
    handles = list(handles)
    deadline = None if timeout is None else time.monotonic() + timeout
    for handle in handles:
        if not handle._done.wait(None if deadline is None else max(0.0, deadline - time.monotonic())):
            break
    for handle in handles:
        if not handle.done():
            handle.cancel()
    finished = sorted((h for h in handles if h.done()), key=lambda h: h._order)
    outcomes = [Outcome(h, h.state == "done", h._value if h.state == "done" else None, None if h.state == "done" else h._error) for h in finished]
    outcomes += [Outcome(h, False, None, Cancelled("the job didn't finish before the timeout")) for h in handles if not h.done()]
    return outcomes
