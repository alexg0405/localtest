from __future__ import annotations

import heapq
from collections import Counter
from typing import Dict, List, Tuple

Record = Tuple[str, str, int, int]  # (package_id, carrier, promised_day, delivered_day)


def _top(counts: Counter, k: int) -> List[str]:
    # Most late first, then alphabetical. nsmallest keeps a heap of size k: O(m log k) for m carriers.
    if k <= 0:
        return []
    return [carrier for carrier, _ in heapq.nsmallest(k, counts.items(), key=lambda item: (-item[1], item[0]))]


def top_late_carriers(records: List[Record], k: int) -> List[str]:
    """Returns the k carriers with the most late packages, the most late first. O(n + m log k)."""
    latest: Dict[str, Tuple[str, bool]] = {}
    for package_id, carrier, promised_day, delivered_day in records:
        latest[package_id] = (carrier, delivered_day > promised_day)  # a later record replaces an earlier one
    return _top(Counter(carrier for carrier, late in latest.values() if late), k)


class LateCarrierTracker:
    """Keeps late counts per carrier up to date as records stream in. record is O(1); top is O(m log k)."""

    def __init__(self) -> None:
        self._packages: Dict[str, Tuple[str, bool]] = {}
        self._counts: Counter = Counter()

    def record(self, package_id: str, carrier: str, promised_day: int, delivered_day: int) -> None:
        previous = self._packages.get(package_id)
        if previous and previous[1]:
            self._counts[previous[0]] -= 1
            if not self._counts[previous[0]]:
                del self._counts[previous[0]]
        late = delivered_day > promised_day
        self._packages[package_id] = (carrier, late)
        if late:
            self._counts[carrier] += 1

    def top(self, k: int) -> List[str]:
        return _top(self._counts, k)
