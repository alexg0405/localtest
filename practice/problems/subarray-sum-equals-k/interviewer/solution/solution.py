from __future__ import annotations

from collections import defaultdict
from typing import DefaultDict, List


def subarray_sum(nums: List[int], k: int) -> int:
    """Count prefix sums seen so far: a subarray ending here sums to k when prefix - k was a prefix before. O(n)."""
    seen: DefaultDict[int, int] = defaultdict(int)
    seen[0] = 1
    prefix = count = 0
    for value in nums:
        prefix += value
        count += seen[prefix - k]
        seen[prefix] += 1
    return count
