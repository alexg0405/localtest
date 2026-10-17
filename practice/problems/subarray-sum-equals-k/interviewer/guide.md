# Interviewer guide: 560. Subarray Sum Equals K

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Brute force:** sum every subarray: O(n²) even with running sums.

**Optimal:** prefix sums plus a hash map. A subarray ending at index j sums to k
exactly when `prefix_j − k` appeared as an earlier prefix. Keep counts of the
prefixes seen so far, starting with `{0: 1}` for the empty prefix. That's O(n)
time and O(n) space.

**Pitfalls:** forgetting the initial `{0: 1}` (misses subarrays starting at
index 0); updating the count before reading it (counts the empty subarray when
k = 0); reaching for a sliding window, which only works for non-negative
numbers.

Target: O(n) time, O(n) space.

## Follow-up questions to ask

- Why doesn't a sliding window work here?
- How would you return the longest subarray with sum k instead of the count?
- What if you needed subarrays whose sum is divisible by k?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
