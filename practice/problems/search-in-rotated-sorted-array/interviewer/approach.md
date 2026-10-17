**Approach:** a modified binary search. At every step one half of
`[low, high]` is sorted: the left half if `nums[low] <= nums[mid]`, otherwise
the right. Check whether the target falls inside the sorted half's range; if so,
search there, otherwise search the other half. That's O(log n) time and O(1)
space.

Another approach: first binary search for the rotation point (the smallest
element), then binary search the correct side.

**Pitfalls:** `<` versus `<=` in the sorted-half test (breaks two-element
lists); comparing against the wrong endpoint; `nums.index` or a linear scan,
which is O(n).
