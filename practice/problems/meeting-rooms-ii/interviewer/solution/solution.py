from __future__ import annotations

import heapq
from typing import List


def min_meeting_rooms(meetings: List[List[int]]) -> int:
    """Sort by start; a min-heap holds the end times of rooms in use. O(n log n) time, O(n) space."""
    ends: List[int] = []
    for start, end in sorted(meetings):
        if ends and ends[0] <= start:
            heapq.heapreplace(ends, end)   # the room that frees up first is free again: reuse it
        else:
            heapq.heappush(ends, end)
    return len(ends)
