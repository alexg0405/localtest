from __future__ import annotations

from typing import List


def merge(intervals: List[List[int]]) -> List[List[int]]:
    """Sort by start, then extend or start a merged interval: O(n log n) time, O(n) space."""
    merged: List[List[int]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
