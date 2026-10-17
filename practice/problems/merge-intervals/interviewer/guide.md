# Interviewer guide: 56. Merge Intervals

Spoilers: this file has the approach. Keep it out of the candidate's workspace.

## Approach

**Approach:** sort by start (O(n log n)), then sweep once. Keep the last
merged interval; if the next one starts at or before its end, extend the end to
the max of both ends, otherwise start a new merged interval. That's O(n log n)
time and O(n) for the output.

**Pitfalls:** using `<` instead of `<=` for touching intervals; overwriting the
end with the new end instead of the max (fails on nested intervals);
forgetting the input isn't sorted.

Target: O(n log n) time, O(n) space.

## Follow-up questions to ask

- How would you insert one new interval into an already merged, sorted list?
- What if the intervals arrived as a stream?
- How would you find the total length covered by all intervals?

## Signals

Green: clarifies constraints first; states brute force and then the optimal
approach with complexity before coding; dry-runs the example; tests edge cases.
Red: codes immediately; silent; can't state the complexity; never tests.
