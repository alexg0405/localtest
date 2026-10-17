# Interviewer guide: 33. Search in Rotated Sorted Array

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

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

Target: O(log n) time, O(1) space.

## Follow-up questions to ask

- What changes if the array can contain duplicates?
- How would you find the rotation point itself?
- How would you find the minimum element?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
