from __future__ import annotations

from typing import Dict, List


def two_sum(nums: List[int], target: int) -> List[int]:
    """One pass with a hash map from value to index: O(n) time, O(n) space."""
    seen: Dict[int, int] = {}
    for i, value in enumerate(nums):
        if target - value in seen:
            return [seen[target - value], i]
        seen[value] = i
    return []
