from __future__ import annotations

import time
from typing import Callable, Tuple, Type, TypeVar

T = TypeVar("T")


def with_retries(
    operation: Callable[[], T],
    max_attempts: int = 3,
    retry_on: Tuple[Type[BaseException], ...] = (Exception,),
    sleep: Callable[[float], None] = time.sleep,
    base_delay: float = 0.05,
) -> T:
    """Calls `operation` until it succeeds, at most `max_attempts` times in total.

    Only exceptions in `retry_on` are retried; anything else, and the error from
    the last attempt, propagates. There is no sleep after the last attempt.
    """
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    for attempt in range(1, max_attempts + 1):
        try:
            return operation()
        except retry_on:
            if attempt == max_attempts:
                raise
            sleep(base_delay * (2 ** (attempt - 1)))
    raise AssertionError("unreachable")
