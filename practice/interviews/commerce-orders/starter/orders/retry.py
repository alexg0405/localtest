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
    """Calls `operation` until it succeeds, backing off exponentially between attempts."""
    last_error: BaseException = RuntimeError("operation was never attempted")
    for attempt in range(max_attempts + 1):
        try:
            return operation()
        except retry_on as error:
            last_error = error
            sleep(base_delay * (2 ** attempt))
    raise last_error
