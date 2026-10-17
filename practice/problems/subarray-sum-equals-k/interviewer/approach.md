**Brute force:** sum every subarray: O(n²) even with running sums.

**Optimal:** prefix sums plus a hash map. A subarray ending at index j sums to k
exactly when `prefix_j − k` appeared as an earlier prefix. Keep counts of the
prefixes seen so far, starting with `{0: 1}` for the empty prefix. That's O(n)
time and O(n) space.

**Pitfalls:** forgetting the initial `{0: 1}` (misses subarrays starting at
index 0); updating the count before reading it (counts the empty subarray when
k = 0); reaching for a sliding window, which only works for non-negative
numbers.
